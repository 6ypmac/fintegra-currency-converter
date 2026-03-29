import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { environment } from '@env/environment';

export type CurrencyOption = { code: string; name: string };

export type ConversionResult = {
  from: string;
  to: string;
  amount: number;
  convertedAmount: number;
  rate: number;
  lastUpdated: string;
};

type CurrencyBeaconCurrency = {
  name: string;
  short_code: string;
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
    date?: string;
  };
};

@Injectable({ providedIn: 'root' })
export class CurrencyApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.currencyBeacon.baseUrl;
  private readonly apiKey = environment.currencyBeacon.apiKey;

  private paramsWithKey(params?: HttpParams): HttpParams {
    return (params ?? new HttpParams()).set('api_key', this.apiKey);
  }

  getCurrencies(type: 'fiat' | 'crypto' = 'fiat'): Observable<CurrencyOption[]> {
    const params = this.paramsWithKey(new HttpParams().set('type', type));

    return this.http
      .get<CurrencyBeaconCurrenciesResponse>(`${this.baseUrl}/currencies`, { params })
      .pipe(
        map((res) =>
          Object.values(res.response).map((c) => ({
            code: c.short_code,
            name: c.name,
          })),
        ),
        map((list) => list.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))),
      );
  }

  convert(from: string, to: string, amount: number): Observable<ConversionResult> {
    const params = this.paramsWithKey(
      new HttpParams().set('from', from).set('to', to).set('amount', String(amount)),
    );

    return this.http
      .get<CurrencyBeaconConvertResponse>(`${this.baseUrl}/convert`, { params })
      .pipe(
        map((res) => {
          const r = res.response;
          const computedRate =
            typeof r.rate === 'number' && Number.isFinite(r.rate)
              ? r.rate
              : r.amount > 0
                ? r.value / r.amount
                : 0;

          return {
            from: r.from,
            to: r.to,
            amount: r.amount,
            convertedAmount: r.value,
            rate: computedRate,
            lastUpdated: r.date ?? new Date().toISOString(),
          };
        }),
      );
  }
}
