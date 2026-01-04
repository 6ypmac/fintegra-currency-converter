import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-currency-converter-form',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './currency-converter-form.component.html',
  styleUrls: ['./currency-converter-form.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CurrencyConverterFormComponent implements OnInit {

  constructor() { }

  ngOnInit(): void {
  }

}
