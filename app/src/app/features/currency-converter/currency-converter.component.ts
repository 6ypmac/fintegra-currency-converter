import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { CurrencyApiService, CurrencyOption, ConversionResult } from '@app/core/services/currency-api.service';

import { Observable, combineLatest, of } from 'rxjs';
import { catchError, distinctUntilChanged, map, shareReplay, startWith, switchMap, tap } from 'rxjs/operators';

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

type Vm = {
  currencies: ReadonlyArray<CurrencyOption>;
  loading: boolean;
  error: string | null;
  result: ConversionResult | null;
};

const ERR = {
  currencies: 'Failed to load currencies',
  pairSame: 'Currencies must be different',
  amount: 'Invalid amount',
  convert: 'Conversion failed',
} as const;

type CurrenciesState = {
  list: ReadonlyArray<CurrencyOption>;
  loading: boolean;
  error: string | null;
};

type ConversionState = {
  loading: boolean;
  error: string | null;
  result: ConversionResult | null;
};

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

  // Form defaults are optimistic UI defaults.
  // Real defaults are re-applied once currencies are loaded (see applyDefaults()).
  readonly form: FormGroup<ConverterForm> = this.fb.group({
    from: this.fb.control('EUR', { validators: [Validators.required] }),
    to: this.fb.control('USD', { validators: [Validators.required] }),
    amount: this.fb.control('1', { validators: [Validators.required] }),
  });

  // Keeps the last successful conversion so the UI doesn't flicker to empty
  // while the user is typing a decimal separator ("1." / "1,") or while a request is in-flight.
  private lastResult: ConversionResult | null = null;

  // Currencies are loaded once and shared across the template.
  // shareReplay prevents multiple HTTP calls when vm$ is subscribed by async pipe.
  private readonly currenciesState$: Observable<CurrenciesState> = this.api.getCurrencies('fiat').pipe(
    tap((list) => this.applyDefaults(list)), // Ensure form selects match available options after load.
    map((list) => ({ list, loading: false, error: null })),
    startWith({ list: [] as CurrencyOption[], loading: true, error: null }),
    catchError(() => of({ list: [] as CurrencyOption[], loading: false, error: ERR.currencies })),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  // startWith makes the initial conversion run immediately using current form values.
  private readonly from$ = this.form.controls.from.valueChanges.pipe(
    startWith(this.form.controls.from.value),
    distinctUntilChanged(),
  );

  // startWith makes the initial conversion run immediately using current form values.
  private readonly to$ = this.form.controls.to.valueChanges.pipe(
    startWith(this.form.controls.to.value),
    distinctUntilChanged(),
  );

  // Parse user input into a small state machine so we can treat "1." as "still typing".
  private readonly amount$ = this.form.controls.amount.valueChanges.pipe(
    startWith(this.form.controls.amount.value),
    distinctUntilChanged(),
    map((raw) => this.parseAmount(raw)),
  );

  // Conversion pipeline:
  // - validates inputs
  // - preserves lastResult while user is typing a decimal separator
  // - performs API call for valid amount and caches the result into lastResult
  private readonly conversionState$: Observable<ConversionState> =
    combineLatest([this.from$, this.to$, this.amount$]).pipe(
      switchMap(([from, to, amount]) => {
        if (!from || !to) {
          return of({ loading: false, error: null, result: this.lastResult });
        }

        if (from === to) {
          return of({ loading: false, error: ERR.pairSame, result: null });
        }

        // User is still typing ("1." / "1,") -> keep showing lastResult instead of clearing the output.
        if (amount.kind === 'empty' || amount.kind === 'inProgress') {
          return of({ loading: false, error: null, result: this.lastResult });
        }

        if (amount.kind === 'invalid') {
          return of({ loading: false, error: ERR.amount, result: null });
        }

        return this.api.convert(from, to, amount.value).pipe(
          tap((res) => (this.lastResult = res)),
          map((res) => ({ loading: false, error: null, result: res })),
          startWith({ loading: true, error: null, result: this.lastResult }),
          catchError(() => of({ loading: false, error: ERR.convert, result: this.lastResult })),
        );
      }),
    );

  // ViewModel for the template: keeps template simple and avoids manual subscriptions in the component.
  readonly vm$: Observable<Vm> = combineLatest([this.currenciesState$, this.conversionState$]).pipe(
    map(([curr, conv]) => ({
      currencies: curr.list,
      loading: curr.loading || conv.loading,
      error: curr.error ?? conv.error,
      result: conv.result,
    })),
  );

  // Picks a valid default pair from the loaded currencies list.
  // Prefers EUR->USD when available, otherwise falls back to the first available codes.
  // Also ensures from !== to.
  private applyDefaults(list: ReadonlyArray<CurrencyOption>): void {
    if (!list.length) return;

    const availableCodes = new Set(list.map((currency) => currency.code));
    const current = this.form.getRawValue();

    const preferredFrom = availableCodes.has('EUR') ? 'EUR' : list[0].code;

    const from = availableCodes.has(current.from) ? current.from : preferredFrom;

    let to: string;
    if (availableCodes.has(current.to)) {
      to = current.to;
    } else if (availableCodes.has('USD')) {
      to = 'USD';
    } else {
      const alternative = list.find((currency) => currency.code !== from);
      to = alternative ? alternative.code : from;
    }

    // keep pair valid
    if (to === from) {
      const alternative = list.find((currency) => currency.code !== from);
      if (alternative) {
        to = alternative.code;
      }
    }

    if (current.from !== from || current.to !== to) {
      this.form.patchValue({ from, to }, { emitEvent: true });
    }
  }

  // Amount parsing rules:
  // - empty => no conversion
  // - "." / trailing "." => user is typing decimals (do not update output yet)
  // - value must be > 0
  // - rounded to 2 decimals for display consistency
  private parseAmount(input: string | null): AmountParse {
    if (input == null) return { kind: 'empty' };

    const text = input.trim();
    if (text === '') return { kind: 'empty' };

    const normalized = text.replace(',', '.');

    // allow "1." / "." while typing
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
