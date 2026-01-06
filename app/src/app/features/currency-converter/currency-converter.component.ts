import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { firstValueFrom } from 'rxjs';
import { CurrencyApiService, CurrencyOption, ConversionResult } from '@app/core/services/currency-api.service';

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

  // -----------------------------
  // UI state (Signals)
  // -----------------------------
  readonly currencies = signal<ReadonlyArray<CurrencyOption>>([]);
  readonly currenciesLoading = signal(true);
  readonly currenciesError = signal<string | null>(null);

  readonly from = signal('EUR');
  readonly to = signal('USD');
  readonly amountText = signal('1');

  readonly conversionLoading = signal(false);
  readonly conversionError = signal<string | null>(null);

  readonly result = signal<ConversionResult | null>(null);
  private readonly lastResult = signal<ConversionResult | null>(null);

  // A simple "ignore stale response" token
  private requestSeq = 0;

  // -----------------------------
  // Derived state
  // -----------------------------
  readonly amountState = computed<AmountParse>(() => this.parseAmount(this.amountText()));
  readonly pairSame = computed(() => {
    const from = this.from();
    const to = this.to();
    return !!from && !!to && from === to;
  });

  // One loading flag for template
  readonly loading = computed(() => this.currenciesLoading() || this.conversionLoading());

  // One error for template (currencies error has priority)
  readonly error = computed(() => this.currenciesError() ?? this.conversionError());

  // Keep showing last successful result while:
  // - request is in flight
  // - user is typing a decimal separator ("1." / "1,")
  readonly displayedResult = computed<ConversionResult | null>(() => {
    if (this.conversionLoading()) return this.lastResult();
    const amount = this.amountState();
    if (amount.kind === 'inProgress' || amount.kind === 'empty') return this.lastResult();
    return this.result();
  });

  constructor() {
    // Load currencies once
    void this.loadCurrencies();

    // Conversion effect (debounced)
    this.setupConversionEffect();
  }

  // -----------------------------
  // Template event handlers
  // -----------------------------
  onAmountInput(value: string): void {
    this.amountText.set(value);
  }

  onFromChange(code: string): void {
    this.from.set(code);
  }

  onToChange(code: string): void {
    this.to.set(code);
  }

  // -----------------------------
  // Loading currencies
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

  // -----------------------------
  // Conversion (Signals + effect + debounce)
  // -----------------------------
  private setupConversionEffect(): void {
    effect((onCleanup) => {
      // Dependencies
      const from = this.from();
      const to = this.to();
      const amount = this.amountState();

      // Debounce without RxJS (classic UI approach)
      const handle = window.setTimeout(() => {
        void this.runConversion(from, to, amount);
      }, 250);

      onCleanup(() => window.clearTimeout(handle));
    });
  }

  private async runConversion(from: string, to: string, amount: AmountParse): Promise<void> {
    // Base validations
    if (!from || !to) {
      this.conversionError.set(null);
      this.result.set(this.lastResult());
      return;
    }

    if (from === to) {
      this.conversionError.set(ERR.pairSame);
      this.result.set(null);
      return;
    }

    // Typing state: keep output stable, no error
    if (amount.kind === 'empty' || amount.kind === 'inProgress') {
      this.conversionError.set(null);
      this.result.set(this.lastResult());
      return;
    }

    if (amount.kind === 'invalid') {
      this.conversionError.set(ERR.amount);
      this.result.set(null);
      return;
    }

    // Actual request
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
  // Defaults
  // -----------------------------
  private applyDefaults(list: ReadonlyArray<CurrencyOption>): void {
    if (!list.length) return;

    const codes = new Set(list.map((currency) => currency.code));

    const preferredFrom = codes.has('EUR') ? 'EUR' : list[0].code;
    const preferredTo = codes.has('USD') ? 'USD' : '';

    const currentFrom = codes.has(this.from()) ? this.from() : preferredFrom;

    let currentTo = codes.has(this.to()) ? this.to() : preferredTo;

    if (!currentTo || currentTo === currentFrom) {
      const alternative = list.find((currency) => currency.code !== currentFrom);
      currentTo = alternative ? alternative.code : currentFrom;
    }

    this.from.set(currentFrom);
    this.to.set(currentTo);

    // If someone wiped the amount before currencies loaded, we still keep a usable default.
    if (!this.amountText().trim()) {
      this.amountText.set('1');
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

    // Allow "1." / "." while typing
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
