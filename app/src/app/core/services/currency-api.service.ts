import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { environment } from '@env/environment';

import { CurrencyOption } from '@app/features/currency-converter/models/currency-option.model';
import { ConversionResult } from '@app/features/currency-converter/models/conversion-result.model';

// ===== CurrencyBeacon API types =====

type CurrencyBeaconCurrency = {
  id: number;
  name: string;
  short_code: string;  // "USD", "EUR"
  code: string;        // numeric ISO
  precision?: number;
  subunit?: number;
  symbol?: string;
  symbol_first?: boolean;
  decimal_mark?: string;
  thousands_separator?: string;
};

type CurrencyBeaconCurrenciesResponse = {
  response: Record<string, CurrencyBeaconCurrency>;
};

type CurrencyBeaconConvertResponse = {
  response: {
    from: string;
    to: string;
    amount: number;
    value: number;
    rate?: number;
    timestamp?: number;
    date?: string;
  };
};

@Injectable({ providedIn: 'root' })
export class CurrencyApiService {
  private readonly http = inject(HttpClient);

  private readonly baseUrl = environment.currencyBeacon.baseUrl;
  private readonly apiKey = environment.currencyBeacon.apiKey;

  private withKey(params?: HttpParams): HttpParams {
    return (params ?? new HttpParams()).set('api_key', this.apiKey);
  }

  public getCurrencies(type: 'fiat' | 'crypto' = 'fiat'): Observable<CurrencyOption[]> {
    const params = this.withKey(new HttpParams().set('type', type));

    return this.http
      .get<CurrencyBeaconCurrenciesResponse>(`${this.baseUrl}/currencies`, { params })
      .pipe(
        map((res) =>
          Object.values(res.response)
            .map((v) => ({
              code: v.short_code,
              name: v.name,
            }))
            .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })),
        ),
      );
  }

  public convert(from: string, to: string, amount: number): Observable<ConversionResult> {
    const params = this.withKey(
      new HttpParams()
        .set('from', from)
        .set('to', to)
        .set('amount', String(amount)),
    );

    return this.http
      .get<CurrencyBeaconConvertResponse>(`${this.baseUrl}/convert`, { params })
      .pipe(
        map((res) => {
          const r = res.response;

          return {
            from: r.from,
            to: r.to,
            amount: r.amount,
            convertedAmount: r.value,
            rate: r.rate,
            lastUpdated: r.date ?? new Date().toISOString(),
          } satisfies ConversionResult;
        }),
      );
  }
}
