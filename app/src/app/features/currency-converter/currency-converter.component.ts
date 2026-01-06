import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { CurrencyApiService, CurrencyOption, ConversionResult } from '@app/core/services/currency-api.service';
import { Subscription, firstValueFrom } from 'rxjs';

type ConverterForm = {
  from: FormControl<string>;
  to: FormControl<string>;
  amount: FormControl<string>;
};

type AmountParse =
  | { kind: 'empty' }
  | { kind: 'inProgress' }
  | { kind: 'invalid' }
  | { kind: 'valid'; value: number };

const ERR = {
  currencies: 'Failed to load currencies',
  pairSame: 'Currencies must be different',
  amount: 'Invalid amount',
  convert: 'Conversion failed',
} as const;

@Component({
  selector: 'app-currency-converter',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatSelectModule,
    MatInputModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './currency-converter.component.html',
  styleUrl: './currency-converter.component.scss',
})
export class CurrencyConverterComponent implements OnInit, OnDestroy {
  private readonly api = inject(CurrencyApiService);
  private readonly fb = inject(NonNullableFormBuilder);

  readonly form: FormGroup<ConverterForm> = this.fb.group({
    from: this.fb.control('EUR', { validators: [Validators.required] }),
    to: this.fb.control('USD', { validators: [Validators.required] }),
    amount: this.fb.control('1', { validators: [Validators.required] }),
  });

  currencies: ReadonlyArray<CurrencyOption> = [];

  loading = false;
  error: string | null = null;
  result: ConversionResult | null = null;

  private lastResult: ConversionResult | null = null;

  private subscriptions = new Subscription();

  private debounceHandle: number | null = null;

  // Used to ignore late responses from older requests (classic race condition fix).
  private requestId = 0;

  async ngOnInit(): Promise<void> {
    await this.loadCurrencies();

    // One subscription for all inputs (simple + predictable).
    this.subscriptions.add(
      this.form.valueChanges.subscribe(() => {
        this.scheduleConversion();
      }),
    );

    // Run initial conversion after init
    this.scheduleConversion();
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();

    if (this.debounceHandle !== null) {
      window.clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
  }

  // -----------------------------
  // Loading currencies (async/await + try/catch)
  // -----------------------------
  private async loadCurrencies(): Promise<void> {
    this.loading = true;
    this.error = null;

    try {
      const list = await firstValueFrom(this.api.getCurrencies('fiat'));
      this.currencies = list;
      this.applyDefaults(list);
    } catch {
      this.currencies = [];
      this.error = ERR.currencies;
    } finally {
      this.loading = false;
    }
  }

  // -----------------------------
  // Conversion flow (imperative)
  // -----------------------------
  private scheduleConversion(): void {
    if (this.debounceHandle !== null) {
      window.clearTimeout(this.debounceHandle);
    }

    this.debounceHandle = window.setTimeout(() => {
      this.debounceHandle = null;
      void this.runConversion();
    }, 250);
  }

  private async runConversion(): Promise<void> {
    const { from, to, amount } = this.form.getRawValue();

    if (!from || !to) {
      this.error = null;
      this.result = this.lastResult;
      return;
    }

    if (from === to) {
      this.error = ERR.pairSame;
      this.result = null;
      return;
    }

    const parsed = this.parseAmount(amount);

    // While user types "1." / "1," keep previous output (no flicker, no wrong value).
    if (parsed.kind === 'empty' || parsed.kind === 'inProgress') {
      this.error = null;
      this.result = this.lastResult;
      return;
    }

    if (parsed.kind === 'invalid') {
      this.error = ERR.amount;
      this.result = null;
      return;
    }

    const currentRequest = ++this.requestId;

    this.loading = true;
    this.error = null;
    this.result = this.lastResult;

    try {
      const res = await firstValueFrom(this.api.convert(from, to, parsed.value));

      // Ignore stale responses
      if (currentRequest !== this.requestId) return;

      this.lastResult = res;
      this.result = res;
    } catch {
      if (currentRequest !== this.requestId) return;

      this.error = ERR.convert;
      this.result = this.lastResult;
    } finally {
      if (currentRequest === this.requestId) {
        this.loading = false;
      }
    }
  }

  // -----------------------------
  // Helpers
  // -----------------------------
  private applyDefaults(list: ReadonlyArray<CurrencyOption>): void {
    if (!list.length) return;

    const codes = new Set(list.map((currency) => currency.code));

    const current = this.form.getRawValue();

    const from = codes.has(current.from) ? current.from : (codes.has('EUR') ? 'EUR' : list[0].code);

    let to = codes.has(current.to) ? current.to : (codes.has('USD') ? 'USD' : '');

    if (!to || to === from) {
      const alternative = list.find((currency) => currency.code !== from);
      to = alternative ? alternative.code : from;
    }

    if (current.from !== from || current.to !== to) {
      this.form.patchValue({ from, to }, { emitEvent: false });
    }
  }

  private parseAmount(input: string | null): AmountParse {
    if (input == null) return { kind: 'empty' };

    const text = input.trim();
    if (text === '') return { kind: 'empty' };

    const normalized = text.replace(',', '.');

    if (normalized === '.' || normalized.endsWith('.')) {
      return { kind: 'inProgress' };
    }

    const value = Number(normalized);
    if (!Number.isFinite(value) || value <= 0) {
      return { kind: 'invalid' };
    }

    const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
    return { kind: 'valid', value: rounded };
  }
}
