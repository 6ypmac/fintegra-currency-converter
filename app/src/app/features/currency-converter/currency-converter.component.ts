import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-currency-converter',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './currency-converter.component.html',
  styleUrls: ['./currency-converter.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CurrencyConverterComponent implements OnInit {

  constructor() { }

  ngOnInit(): void {
  }

}
