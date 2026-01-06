import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { firstValueFrom } from 'rxjs';
import { startWith } from 'rxjs/operators';
import { toSignal } from '@angular/core/rxjs-interop';

import { CurrencyApiService, CurrencyOption, ConversionResult } from '@app/core/services/currency-api.service';

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
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CurrencyConverterComponent {
  private readonly api = inject(CurrencyApiService);
  private readonly fb = inject(NonNullableFormBuilder);

  // Reactive Form = single source of truth for user input
  readonly form: FormGroup<ConverterForm> = this.fb.group({
    from: this.fb.control('EUR', { validators: [Validators.required] }),
    to: this.fb.control('USD', { validators: [Validators.required] }),
    amount: this.fb.control('1', { validators: [Validators.required] }),
  });

  // Signals for async state + results
  readonly currencies = signal<ReadonlyArray<CurrencyOption>>([]);
  readonly currenciesLoading = signal(true);
  readonly currenciesError = signal<string | null>(null);

  readonly conversionLoading = signal(false);
  readonly conversionError = signal<string | null>(null);

  readonly result = signal<ConversionResult | null>(null);
  private readonly lastResult = signal<ConversionResult | null>(null);

  // Used to ignore late responses from older requests
  private requestSeq = 0;

  // Bridge FormControl -> Signals (so we can use computed/effect cleanly)
  readonly fromCode = toSignal(
    this.form.controls.from.valueChanges.pipe(startWith(this.form.controls.from.value)),
    { initialValue: this.form.controls.from.value },
  );

  readonly toCode = toSignal(
    this.form.controls.to.valueChanges.pipe(startWith(this.form.controls.to.value)),
    { initialValue: this.form.controls.to.value },
  );

  readonly amountText = toSignal(
    this.form.controls.amount.valueChanges.pipe(startWith(this.form.controls.amount.value)),
    { initialValue: this.form.controls.amount.value },
  );

  // Derived state
  readonly amountState = computed<AmountParse>(() => this.parseAmount(this.amountText()));
  readonly loading = computed(() => this.currenciesLoading() || this.conversionLoading());
  readonly error = computed(() => this.currenciesError() ?? this.conversionError());

  readonly displayedResult = computed<ConversionResult | null>(() => {
    if (this.conversionLoading()) return this.lastResult();

    const amount = this.amountState();
    if (amount.kind === 'empty' || amount.kind === 'inProgress') return this.lastResult();

    return this.result();
  });

  constructor() {
    void this.loadCurrencies();

    // Debounced conversion as a signal effect
    effect((onCleanup) => {
      const from = this.fromCode();
      const to = this.toCode();
      const amount = this.amountState();

      const handle = window.setTimeout(() => {
        void this.runConversion(from, to, amount);
      }, 250);

      onCleanup(() => window.clearTimeout(handle));
    });
  }

  // -----------------------------
  // Currencies
  // -----------------------------
  private async loadCurrencies(): Promise<void> {
    this.currenciesLoading.set(true);
    this.currenciesError.set(null);

    try {
      const list = await firstValueFrom(this.api.getCurrencies('fiat'));
      this.currencies.set(list);
      this.applyDefaults(list);
    } catch {
      this.currencies.set([]);
      this.currenciesError.set(ERR.currencies);
    } finally {
      this.currenciesLoading.set(false);
    }
  }

  private applyDefaults(list: ReadonlyArray<CurrencyOption>): void {
    if (!list.length) return;

    const available = new Set(list.map((currency) => currency.code));

    const current = this.form.getRawValue();

    const from = available.has(current.from)
      ? current.from
      : (available.has('EUR') ? 'EUR' : list[0].code);

    let to: string;
    if (available.has(current.to) && current.to !== from) {
      to = current.to;
    } else if (available.has('USD') && 'USD' !== from) {
      to = 'USD';
    } else {
      const alternative = list.find((currency) => currency.code !== from);
      to = alternative ? alternative.code : from;
    }

    const patch: Partial<{ from: string; to: string; amount: string }> = {};
    if (current.from !== from) patch.from = from;
    if (current.to !== to) patch.to = to;

    // Keep amount usable if user cleared it before currencies arrived
    if (!String(current.amount ?? '').trim()) patch.amount = '1';

    if (Object.keys(patch).length) {
      this.form.patchValue(patch, { emitEvent: true });
    }
  }

  // -----------------------------
  // Conversion
  // -----------------------------
  private async runConversion(from: string, to: string, amount: AmountParse): Promise<void> {
    // No pair -> keep output quiet
    if (!from || !to) {
      this.conversionError.set(null);
      this.result.set(this.lastResult());
      return;
    }

    // Same pair -> error + clear result (task requirement)
    if (from === to) {
      this.conversionError.set(ERR.pairSame);
      this.result.set(null);
      return;
    }

    // While user types "1." / "1," -> keep previous output, no error
    if (amount.kind === 'empty' || amount.kind === 'inProgress') {
      this.conversionError.set(null);
      this.result.set(this.lastResult());
      return;
    }

    // Invalid amount -> error + clear result (task requirement)
    if (amount.kind === 'invalid') {
      this.conversionError.set(ERR.amount);
      this.result.set(null);
      return;
    }

    const seq = ++this.requestSeq;

    this.conversionLoading.set(true);
    this.conversionError.set(null);
    this.result.set(this.lastResult());

    try {
      const res = await firstValueFrom(this.api.convert(from, to, amount.value));

      if (seq !== this.requestSeq) return; // stale response
      this.lastResult.set(res);
      this.result.set(res);
    } catch {
      if (seq !== this.requestSeq) return; // stale response
      this.conversionError.set(ERR.convert);
      this.result.set(this.lastResult());
    } finally {
      if (seq === this.requestSeq) {
        this.conversionLoading.set(false);
      }
    }
  }

  // -----------------------------
  // Amount parsing
  // -----------------------------
  private parseAmount(raw: string | null): AmountParse {
    if (raw == null) return { kind: 'empty' };

    const text = raw.trim();
    if (text === '') return { kind: 'empty' };

    const normalized = text.replace(',', '.');

    // Allow "." / "1." while typing
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
