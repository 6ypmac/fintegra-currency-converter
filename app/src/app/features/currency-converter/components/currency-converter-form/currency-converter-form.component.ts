import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  EventEmitter,
  Input,
  OnChanges,
  OnInit,
  Output,
  SimpleChanges,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  AbstractControl,
  FormControl,
  FormGroup,
  NonNullableFormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  ValidatorFn,
  Validators,
} from '@angular/forms';
import { merge } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { CurrencyOption } from '../../models/currency-option.model';
import { ConversionRequest, EditedSide } from '../../models/conversion-request.model';
import { ConversionResult } from '../../models/conversion-result.model';

type AmountParse =
  | { kind: 'empty' }
  | { kind: 'inProgress' }
  | { kind: 'invalid'; reason: 'negative' | 'invalidNumber' }
  | { kind: 'valid'; value: number };

type ConverterFormControls = {
  from: FormControl<string>;
  to: FormControl<string>;
  fromAmount: FormControl<string>;
  toAmount: FormControl<string>;
};

@Component({
  selector: 'app-currency-converter-form',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatSelectModule,
    MatInputModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './currency-converter-form.component.html',
  styleUrl: './currency-converter-form.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CurrencyConverterFormComponent implements OnInit, OnChanges {
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly destroyRef = inject(DestroyRef);

  private static readonly ERR_NEGATIVE = 'Amount cannot be negative';
  private static readonly ERR_INVALID = 'Invalid number';
  private static readonly ERR_SAME_CCY = 'Currencies must be different';

  private readonly nf = new Intl.NumberFormat('de-DE', {
    useGrouping: false,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

  @Input({ required: true }) public currencies: ReadonlyArray<CurrencyOption> = [];
  @Input() public loading = false;
  @Input() public error: string | null = null;
  @Input() public result: ConversionResult | null = null;
  @Input() public lastEdited: EditedSide = 'from';

  @Output() public readonly requestChange = new EventEmitter<ConversionRequest>();

  private editedLocal: EditedSide = 'from';

  public readonly form: FormGroup<ConverterFormControls> = this.fb.group(
    {
      from: this.fb.control('EUR', { validators: [Validators.required] }),
      to: this.fb.control('USD', { validators: [Validators.required] }),

      fromAmount: this.fb.control('1', { validators: [this.amountStringValidator()] }),
      toAmount: this.fb.control('', { validators: [this.amountStringValidator()] }),
    },
    { validators: [this.differentCurrenciesValidator()] },
  );

  public ngOnInit(): void {
    this.initStreams();
  }

  public ngOnChanges(changes: SimpleChanges): void {
    if (!changes['result'] || !this.result) return;

    if (this.lastEdited === 'from') {
      this.form.controls.toAmount.setValue(this.format2(this.result.convertedAmount), { emitEvent: false });
    } else {
      this.form.controls.fromAmount.setValue(this.format2(this.result.amount), { emitEvent: false });
    }
  }

  public get fromAmountError(): string | null {
    return this.amountErrorOf(this.form.controls.fromAmount);
  }

  public get toAmountError(): string | null {
    return this.amountErrorOf(this.form.controls.toAmount);
  }

  public get currencyError(): string | null {
    return this.form.hasError('sameCurrency') ? CurrencyConverterFormComponent.ERR_SAME_CCY : null;
  }

  private initStreams(): void {
    this.form.controls.fromAmount.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => (this.editedLocal = 'from'));

    this.form.controls.toAmount.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => (this.editedLocal = 'to'));

    this.form.controls.from.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.ensureDifferentCurrencies('from'));

    this.form.controls.to.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.ensureDifferentCurrencies('to'));

    merge(
      this.form.controls.from.valueChanges,
      this.form.controls.to.valueChanges,
      this.form.controls.fromAmount.valueChanges,
      this.form.controls.toAmount.valueChanges,
    )
      .pipe(
        map(() => this.buildRequestOrNull()),
        filter((v): v is ConversionRequest => v !== null),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((req) => this.requestChange.emit(req));
  }

  private amountErrorOf(c: AbstractControl<string>): string | null {
    if (!c.touched && !c.dirty) return null;
    if (c.hasError('negative')) return CurrencyConverterFormComponent.ERR_NEGATIVE;
    if (c.hasError('invalidNumber')) return CurrencyConverterFormComponent.ERR_INVALID;
    return null;
  }

  private buildRequestOrNull(): ConversionRequest | null {
    const { from, to, fromAmount, toAmount } = this.form.getRawValue();
    if (!from || !to) return null;
    if (from === to) return null;

    const raw = this.editedLocal === 'from' ? fromAmount : toAmount;
    const parsed = this.parseAmount(raw);

    const otherCtrl =
      this.editedLocal === 'from' ? this.form.controls.toAmount : this.form.controls.fromAmount;

    if (parsed.kind === 'empty' || parsed.kind === 'invalid' || parsed.kind === 'inProgress') {
      otherCtrl.setValue('', { emitEvent: false });
      return null;
    }

    return { from, to, amount: parsed.value, edited: this.editedLocal };
  }

  private ensureDifferentCurrencies(changed: EditedSide): void {
    const { from, to } = this.form.getRawValue();
    if (!from || !to) return;
    if (from !== to) return;

    const fallback = this.currencies.find((c) => c.code !== from)?.code ?? '';
    if (!fallback) return;

    if (changed === 'from') {
      this.form.controls.to.setValue(fallback, { emitEvent: false });
    } else {
      this.form.controls.from.setValue(fallback, { emitEvent: false });
    }

    this.form.updateValueAndValidity({ emitEvent: false });
  }

  private differentCurrenciesValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const group = control as unknown as { value: ConverterFormControls };
      const { from, to } = group.value ?? ({} as ConverterFormControls);
      if (!from || !to) return null;
      return from === to ? { sameCurrency: true } : null;
    };
  }

  private parseAmount(raw: string): AmountParse {
    const v = (raw ?? '').trim();

    if (v === '') return { kind: 'empty' };
    if (v.startsWith('-')) return { kind: 'invalid', reason: 'negative' };
    if (v === '.' || v === ',' || /[.,]$/.test(v)) return { kind: 'inProgress' };

    const normalized = v.replace(',', '.');
    if (!/^\d+(\.\d+)?$/.test(normalized)) return { kind: 'invalid', reason: 'invalidNumber' };

    const num = Number(normalized);
    if (!Number.isFinite(num) || num < 0) return { kind: 'invalid', reason: 'invalidNumber' };

    const rounded = Math.round((num + Number.EPSILON) * 100) / 100;
    return { kind: 'valid', value: rounded };
  }

  private amountStringValidator(): ValidatorFn {
    return (control: AbstractControl<string>): ValidationErrors | null => {
      const parsed = this.parseAmount(control.value ?? '');
      if (parsed.kind === 'invalid') {
        return parsed.reason === 'negative' ? { negative: true } : { invalidNumber: true };
      }
      return null;
    };
  }

  private format2(v: number): string {
    if (!Number.isFinite(v)) return '';
    const rounded = Math.round((v + Number.EPSILON) * 100) / 100;
    return this.nf.format(rounded);
  }
}
