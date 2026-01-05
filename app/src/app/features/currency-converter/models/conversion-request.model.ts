export type EditedSide = 'from' | 'to';

export interface ConversionRequest {
  from: string;
  to: string;
  amount: number;
  edited: EditedSide;
}
