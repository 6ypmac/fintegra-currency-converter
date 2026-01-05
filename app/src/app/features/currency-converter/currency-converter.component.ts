import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CurrencyConverterFormComponent } from './components/currency-converter-form/currency-converter-form.component';

import { CurrencyApiService } from '@app/core/services/currency-api.service';
import { CurrencyOption } from './models/currency-option.model';
import { ConversionRequest, EditedSide } from './models/conversion-request.model';
import { ConversionResult } from './models/conversion-result.model';

import { Observable, Subject, combineLatest, merge, of } from 'rxjs';
import {
  catchError,
  distinctUntilChanged,
  filter,
  map,
  shareReplay,
  startWith,
  switchMap,
} from 'rxjs/operators';

type InitialForm = { from: string; to: string; amount: string };

type ConversionResultWithRate = ConversionResult & { rate: number };

type PairRateState = {
  from: string;
  to: string;
  rate: number;
  lastUpdated: string;
  loading: boolean;
  error: string | null;
};

@Component({
  selector: 'app-currency-converter',
  standalone: true,
  imports: [CommonModule, CurrencyConverterFormComponent],
  templateUrl: './currency-converter.component.html',
  styleUrl: './currency-converter.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CurrencyConverterComponent {
  private readonly api = inject(CurrencyApiService);

  private readonly userRequests$ = new Subject<ConversionRequest>();

  // -----------------------------
  // Currencies
  // -----------------------------
  readonly currencies$: Observable<ReadonlyArray<CurrencyOption>> = this.api.getCurrencies('fiat').pipe(
    catchError(() => of([] as CurrencyOption[])),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  readonly currenciesLoading$: Observable<boolean> = this.currencies$.pipe(
    map((list) => list.length === 0),
    startWith(true),
  );

  readonly currenciesError$: Observable<string | null> = this.api.getCurrencies('fiat').pipe(
    map(() => null),
    startWith(null),
    catchError(() => of('Failed to load currencies')),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  // -----------------------------
  // Initial form (once list is ready)
  // -----------------------------
  readonly initial$: Observable<InitialForm | null> = this.currencies$.pipe(
    map((list) => (list.length ? this.pickInitial(list) : null)),
    startWith(null),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  // -----------------------------
  // Requests (initial + user)
  // -----------------------------
  readonly requests$: Observable<ConversionRequest> = merge(
    this.initial$.pipe(
      filter((v): v is InitialForm => v !== null),
      map((init) => ({
        from: init.from,
        to: init.to,
        amount: Number(init.amount) || 1,
        edited: 'from' as const,
      })),
    ),
    this.userRequests$,
  ).pipe(
    distinctUntilChanged((a, b) =>
      a.from === b.from &&
      a.to === b.to &&
      a.amount === b.amount &&
      a.edited === b.edited,
    ),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  readonly lastEdited$: Observable<EditedSide> = this.requests$.pipe(
    map((r) => r.edited),
    startWith('from' as EditedSide),
  );

  // -----------------------------
  // Rate (API call only on pair change)
  // -----------------------------
  readonly pairRate$: Observable<PairRateState> = this.requests$.pipe(
    map((r) => ({ from: r.from, to: r.to })),
    distinctUntilChanged((a, b) => a.from === b.from && a.to === b.to),

    switchMap(({ from, to }) =>
      this.api.convert(from, to, 1).pipe(
        map((res) => this.ensureRate(res)),
        map((res) => ({
          from,
          to,
          rate: res.rate,
          lastUpdated: res.lastUpdated,
          loading: false,
          error: null,
        })),
        startWith({
          from,
          to,
          rate: 0,
          lastUpdated: '',
          loading: true,
          error: null,
        }),
        catchError(() =>
          of({
            from,
            to,
            rate: 0,
            lastUpdated: '',
            loading: false,
            error: 'Conversion failed',
          }),
        ),
      ),
    ),
    startWith({
      from: 'EUR',
      to: 'USD',
      rate: 0,
      lastUpdated: '',
      loading: false,
      error: null,
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  // -----------------------------
  // Result computed locally from cached rate
  // -----------------------------
  readonly result$: Observable<ConversionResult | null> = combineLatest([this.requests$, this.pairRate$]).pipe(
    map(([req, rateState]) => {
      if (rateState.loading) return null;
      if (rateState.error) return null;

      // ignore stale rate
      if (rateState.from !== req.from || rateState.to !== req.to) return null;

      return this.computeWithRate(req, rateState.rate, rateState.lastUpdated);
    }),
    startWith(null),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  // -----------------------------
  // VM for template
  // -----------------------------
  readonly vm$ = combineLatest({
    currencies: this.currencies$,
    initial: this.initial$,
    pairRate: this.pairRate$,
    result: this.result$,
    lastEdited: this.lastEdited$,
    currenciesError: this.currenciesError$,
  }).pipe(
    map(({ currencies, initial, pairRate, result, lastEdited, currenciesError }) => {
      const loading = pairRate.loading;
      const error = currenciesError ?? pairRate.error;

      return {
        currencies,
        initial,
        loading,
        error,
        result,
        lastEdited,
      };
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  // -----------------------------
  // events
  // -----------------------------
  onRequestChange(req: ConversionRequest): void {
    this.userRequests$.next(req);
  }

  // -----------------------------
  // helpers
  // -----------------------------
  private pickInitial(list: ReadonlyArray<CurrencyOption>): InitialForm {
    const codes = new Set(list.map((c) => c.code));

    const from = codes.has('EUR') ? 'EUR' : (list[0]?.code ?? 'EUR');
    const to =
      codes.has('USD')
        ? 'USD'
        : (list.find((c) => c.code !== from)?.code ?? 'USD');

    return { from, to, amount: '1' };
  }

  private ensureRate(res: ConversionResult): ConversionResultWithRate {
    const rate =
      typeof res.rate === 'number' && Number.isFinite(res.rate) && res.rate > 0
        ? res.rate
        : res.amount > 0 && Number.isFinite(res.convertedAmount)
          ? res.convertedAmount / res.amount
          : 0;

    return { ...res, rate };
  }

  private computeWithRate(req: ConversionRequest, rate: number, lastUpdated: string): ConversionResult {
    const r = Number.isFinite(rate) && rate > 0 ? rate : 0;

    if (req.edited === 'from') {
      return {
        from: req.from,
        to: req.to,
        amount: req.amount,
        convertedAmount: r === 0 ? 0 : req.amount * r,
        rate: r,
        lastUpdated,
      };
    }

    // edited === 'to': req.amount means "to amount"
    return {
      from: req.from,
      to: req.to,
      amount: r === 0 ? 0 : req.amount / r,
      convertedAmount: req.amount,
      rate: r,
      lastUpdated,
    };
  }
}
