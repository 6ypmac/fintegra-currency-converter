import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CurrencyConverterFormComponent } from './components/currency-converter-form/currency-converter-form.component';

import { CurrencyOption } from './models/currency-option.model';
import { ConversionRequest, EditedSide } from './models/conversion-request.model';
import { ConversionResult } from './models/conversion-result.model';

import { Observable, ReplaySubject, of } from 'rxjs';
import { catchError, distinctUntilChanged, finalize, map, switchMap, tap } from 'rxjs/operators';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

// TODO: replace with real API service later
function fakeConvert(from: string, to: string, amount: number): Observable<ConversionResult> {
  const rate = 1.1;
  const convertedAmount = Math.round((amount * rate + Number.EPSILON) * 100) / 100;

  return of({
    from,
    to,
    amount,
    convertedAmount,
    rate,
    lastUpdated: new Date().toISOString(),
  });
}

@Component({
  selector: 'app-currency-converter',
  standalone: true,
  imports: [CommonModule, CurrencyConverterFormComponent],
  templateUrl: './currency-converter.component.html',
  styleUrl: './currency-converter.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CurrencyConverterComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);

  private readonly requests$ = new ReplaySubject<ConversionRequest>(1);

  public readonly currencies: ReadonlyArray<CurrencyOption> = [
    { code: 'EUR', name: 'Euro' },
    { code: 'USD', name: 'US Dollar' },
    { code: 'GBP', name: 'British Pound' },
    { code: 'CHF', name: 'Swiss Franc' },
  ];

  public loading = false;
  public error: string | null = null;
  public result: ConversionResult | null = null;

  public lastEdited: EditedSide = 'from';

  public ngOnInit(): void {
    this.requests$.next({
      from: 'EUR',
      to: 'USD',
      amount: 1,
      edited: 'from',
    });

    this.requests$
      .pipe(
        distinctUntilChanged(CurrencyConverterComponent.sameRequest),

        tap((req) => {
          this.lastEdited = req.edited;
          this.loading = true;
          this.error = null;
        }),

        switchMap((req) =>
          this.convert(req).pipe(
            catchError(() => {
              this.error = 'Conversion failed';
              return of(null);
            }),
            finalize(() => {
              this.loading = false;
            }),
          ),
        ),

        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        if (res) this.result = res;
      });
  }

  public onRequestChange(req: ConversionRequest): void {
    this.requests$.next(req);
  }

  private convert(req: ConversionRequest): Observable<ConversionResult> {
    const apiFrom = req.edited === 'from' ? req.from : req.to;
    const apiTo   = req.edited === 'from' ? req.to   : req.from;

    return fakeConvert(apiFrom, apiTo, req.amount).pipe(
      map((apiRes) => this.normalizeResult(req, apiRes)),
    );
  }

  private normalizeResult(req: ConversionRequest, apiRes: ConversionResult): ConversionResult {
    if (req.edited === 'from') return apiRes;

    const invertedRate = apiRes.rate === 0 ? 0 : 1 / apiRes.rate;

    return {
      from: req.from,
      to: req.to,
      amount: apiRes.convertedAmount,
      convertedAmount: apiRes.amount,
      rate: invertedRate,
      lastUpdated: apiRes.lastUpdated,
    };
  }

  private static sameRequest(a: ConversionRequest, b: ConversionRequest): boolean {
    return (
      a.from === b.from &&
      a.to === b.to &&
      a.amount === b.amount &&
      a.edited === b.edited
    );
  }
}
