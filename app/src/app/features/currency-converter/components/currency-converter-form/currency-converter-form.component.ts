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

import { CurrencyOption } from '@app/features/currency-converter/models/currency-option.model';
import { ConversionRequest, EditedSide } from '@app/features/currency-converter/models/conversion-request.model';
import { ConversionResult } from '@app/features/currency-converter/models/conversion-result.model';

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

type Initial = { from: string; to: string; amount: string };

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

  private readonly nf = new Intl.NumberFormat('de-DE', {
    useGrouping: false,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

  @Input({ required: true }) currencies: ReadonlyArray<CurrencyOption> = [];
  @Input() initial: Initial | null = null;
  @Input() loading = false;
  @Input() result: ConversionResult | null = null;
  @Input() lastEdited: EditedSide = 'from';

  @Output() readonly requestChange = new EventEmitter<ConversionRequest>();

  readonly form: FormGroup<ConverterFormControls> = this.fb.group(
    {
      from: this.fb.control('EUR', { validators: [Validators.required] }),
      to: this.fb.control('USD', { validators: [Validators.required] }),
      fromAmount: this.fb.control('1', { validators: [this.amountStringValidator()] }),
      toAmount: this.fb.control('', { validators: [this.amountStringValidator()] }),
    },
    { validators: [this.differentCurrenciesValidator()] },
  );

  private editedLocal: EditedSide = 'from';

  private internalUpdate = false;

  // for swap: remember previous values
  private prevFrom = 'EUR';
  private prevTo = 'USD';

  ngOnInit(): void {
    this.prevFrom = this.form.controls.from.value;
    this.prevTo = this.form.controls.to.value;
    this.initStreams();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['currencies']) {
      this.ensureSelectionsValid();
      this.snapshotPair();
    }

    if (changes['initial'] && this.initial) {
      this.internalUpdate = true;

      this.form.patchValue(
        {
          from: this.initial.from,
          to: this.initial.to,
          fromAmount: this.initial.amount,
        },
        { emitEvent: false },
      );

      this.ensureSelectionsValid();
      this.form.updateValueAndValidity({ emitEvent: false });
      this.snapshotPair();

      this.internalUpdate = false;
    }

    if (changes['result'] && this.result) {
      this.internalUpdate = true;

      if (this.lastEdited === 'from') {
        this.form.controls.toAmount.setValue(this.format2(this.result.convertedAmount), { emitEvent: false });
      } else {
        this.form.controls.fromAmount.setValue(this.format2(this.result.amount), { emitEvent: false });
      }

      this.internalUpdate = false;
    }
  }

  get fromAmountError(): string | null {
    return this.amountErrorOf(this.form.controls.fromAmount);
  }

  get toAmountError(): string | null {
    return this.amountErrorOf(this.form.controls.toAmount);
  }

  // -----------------------------
  // streams
  // -----------------------------
  private initStreams(): void {
    this.form.controls.fromAmount.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (!this.internalUpdate) this.editedLocal = 'from';
      });

    this.form.controls.toAmount.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (!this.internalUpdate) this.editedLocal = 'to';
      });

    this.form.controls.from.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((newFrom) => {
        if (this.internalUpdate) return;
        this.applySwapIfSame('from', newFrom);
        this.form.updateValueAndValidity({ emitEvent: false });
      });

    this.form.controls.to.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((newTo) => {
        if (this.internalUpdate) return;
        this.applySwapIfSame('to', newTo);
        this.form.updateValueAndValidity({ emitEvent: false });
      });

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

  // -----------------------------
  // swap logic
  // -----------------------------
  private applySwapIfSame(changed: EditedSide, newValue: string): void {
    const fromCtrl = this.form.controls.from;
    const toCtrl = this.form.controls.to;

    if (changed === 'from') {
      if (newValue && newValue === toCtrl.value) {
        this.internalUpdate = true;
        toCtrl.setValue(this.prevFrom, { emitEvent: false });
        this.internalUpdate = false;
      }
    } else {
      if (newValue && newValue === fromCtrl.value) {
        this.internalUpdate = true;
        fromCtrl.setValue(this.prevTo, { emitEvent: false });
        this.internalUpdate = false;
      }
    }

    this.snapshotPair();
  }

  private snapshotPair(): void {
    this.prevFrom = this.form.controls.from.value;
    this.prevTo = this.form.controls.to.value;
  }

  // -----------------------------
  // selection guard
  // -----------------------------
  private ensureSelectionsValid(): void {
    if (!this.currencies?.length) return;

    const has = (code: string) => this.currencies.some((c) => c.code === code);

    const fromCtrl = this.form.controls.from;
    const toCtrl = this.form.controls.to;

    if (!has(fromCtrl.value)) {
      this.internalUpdate = true;
      fromCtrl.setValue(this.currencies[0].code, { emitEvent: false });
      this.internalUpdate = false;
    }

    if (!has(toCtrl.value) || toCtrl.value === fromCtrl.value) {
      const fallbackTo = this.currencies.find((c) => c.code !== fromCtrl.value)?.code ?? fromCtrl.value;

      this.internalUpdate = true;
      toCtrl.setValue(fallbackTo, { emitEvent: false });
      this.internalUpdate = false;
    }
  }

  private differentCurrenciesValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const group = control as unknown as { value: ConverterFormControls };
      const { from, to } = group.value ?? ({} as ConverterFormControls);

      if (!from || !to) return null;
      return from === to ? { sameCurrency: true } : null;
    };
  }

  // -----------------------------
  // build request
  // -----------------------------
  private buildRequestOrNull(): ConversionRequest | null {
    const { from, to, fromAmount, toAmount } = this.form.getRawValue();
    if (!from || !to) return null;
    if (from === to) return null;

    const raw = this.editedLocal === 'from' ? fromAmount : toAmount;
    const parsed = this.parseAmount(raw);

    const otherCtrl = this.editedLocal === 'from'
      ? this.form.controls.toAmount
      : this.form.controls.fromAmount;

    if (parsed.kind === 'empty' || parsed.kind === 'invalid' || parsed.kind === 'inProgress') {
      otherCtrl.setValue('', { emitEvent: false });
      return null;
    }

    return { from, to, amount: parsed.value, edited: this.editedLocal };
  }

  // -----------------------------
  // parsing
  // -----------------------------
  private parseAmount(raw: string): AmountParse {
    const v = (raw ?? '').trim();

    if (v === '') return { kind: 'empty' };
    if (v.startsWith('-')) return { kind: 'invalid', reason: 'negative' };

    // allow ".5" / ",5" => treat as "0.5"
    if ((v.startsWith('.') || v.startsWith(',')) && v.length > 1) {
      const tail = v.slice(1);
      if (/^\d+$/.test(tail)) {
        return this.parseAmount('0' + v);
      }
    }

    // in progress: ".", "," or trailing separator
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

  private amountErrorOf(c: AbstractControl<string>): string | null {
    if (!c.touched && !c.dirty) return null;
    if (c.hasError('negative')) return CurrencyConverterFormComponent.ERR_NEGATIVE;
    if (c.hasError('invalidNumber')) return CurrencyConverterFormComponent.ERR_INVALID;
    return null;
  }

  private format2(v: number): string {
    if (!Number.isFinite(v)) return '';
    const rounded = Math.round((v + Number.EPSILON) * 100) / 100;
    return this.nf.format(rounded);
  }
}
