import { ComponentFixture, TestBed } from '@angular/core/testing';

import { CurrencyConverterFormComponent } from './currency-converter-form.component';

describe('CurrencyConverterFormComponent', () => {
  let component: CurrencyConverterFormComponent;
  let fixture: ComponentFixture<CurrencyConverterFormComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ CurrencyConverterFormComponent ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(CurrencyConverterFormComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
