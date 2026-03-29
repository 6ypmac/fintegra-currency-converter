import { Component } from '@angular/core';
import { CurrencyConverterComponent } from './features/currency-converter/currency-converter.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CurrencyConverterComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {}
