import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { CurrencyApiService, CurrencyOption, ConversionResult } from '@app/core/services/currency-api.service';
import { Observable, of } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, finalize, startWith, switchMap, tap } from 'rxjs/operators';

type ConverterForm = {
  from: FormControl<string>;
  to: FormControl<string>;
  amount: FormControl<string>;
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
export class CurrencyConverterComponent implements OnInit {
  private readonly api = inject(CurrencyApiService);
  private readonly fb = inject(NonNullableFormBuilder);

  currencies: ReadonlyArray<CurrencyOption> = [];

  loading = false;
  error: string | null = null;

  result: ConversionResult | null = null;

  readonly form: FormGroup<ConverterForm> = this.fb.group({
    from: this.fb.control('EUR', { validators: [Validators.required] }),
    to: this.fb.control('USD', { validators: [Validators.required] }),
    amount: this.fb.control('1', { validators: [Validators.required] }),
  });

  ngOnInit(): void {
    // 1) load currencies + ensure defaults exist
    this.api.getCurrencies('fiat').subscribe({
      next: (list) => {
        this.currencies = list;

        const codes = new Set(list.map((c) => c.code));
        const from = codes.has('EUR') ? 'EUR' : (list[0]?.code ?? 'EUR');
        const to = codes.has('USD')
          ? 'USD'
          : (list.find((c) => c.code !== from)?.code ?? 'USD');

        this.form.patchValue({ from, to, amount: '1' }, { emitEvent: true });
      },
      error: () => {
        this.error = 'Failed to load currencies';
      },
    });

    // 2) conversion stream (simple)
    this.setupConversion();
  }

  private setupConversion(): void {
    const from$ = this.form.controls.from.valueChanges.pipe(startWith(this.form.controls.from.value));
    const to$ = this.form.controls.to.valueChanges.pipe(startWith(this.form.controls.to.value));
    const amount$ = this.form.controls.amount.valueChanges.pipe(
      startWith(this.form.controls.amount.value),
      debounceTime(300),
      distinctUntilChanged(),
    );

    from$.pipe(
      switchMap(() => this.buildConversion$()),
    ).subscribe();

    to$.pipe(
      switchMap(() => this.buildConversion$()),
    ).subscribe();

    amount$.pipe(
      switchMap(() => this.buildConversion$()),
    ).subscribe();
  }

  private buildConversion$(): Observable<ConversionResult | null> {
    const from = this.form.controls.from.value;
    const to = this.form.controls.to.value;
    const rawAmount = this.form.controls.amount.value;

    const amount = Number(String(rawAmount).replace(',', '.'));

    if (!from || !to) return of(null);
    if (from === to) {
      this.error = 'Currencies must be different';
      this.result = null;
      return of(null);
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      this.result = null;
      return of(null);
    }

    this.loading = true;
    this.error = null;

    return this.api.convert(from, to, amount).pipe(
      tap((res) => (this.result = res)),
      catchError(() => {
        this.error = 'Conversion failed';
        this.result = null;
        return of(null);
      }),
      finalize(() => (this.loading = false)),
    );
  }
}
