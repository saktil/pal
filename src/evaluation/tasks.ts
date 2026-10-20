export const checkout = {
  id: "checkout-rounding",
  version: 1,
  split: "development",
  entrypoint: "src/main.mjs",
  prompt:
    "Fix the checkout receipt's inconsistent rounding in src/prices.mjs and src/receipt.mjs. " +
    "Prices are nonnegative decimal strings with up to three decimal places; quantities are positive integers. " +
    "Round each unit price to cents, halfway up, before multiplying by quantity and summing. " +
    "Keep the CLI's JSON shape: {unitCents: number[], totalCents: number}. Run node test.mjs.",
  cases: [
    {
      id: "ordinary",
      input: [{ price: "12.34", quantity: 2 }],
      expected: { unitCents: [1234], totalCents: 2468 },
    },
    {
      id: "binary-rounding",
      input: [{ price: "1.005", quantity: 2 }],
      expected: { unitCents: [101], totalCents: 202 },
    },
    {
      id: "unit-before-quantity",
      input: [{ price: "0.105", quantity: 3 }],
      expected: { unitCents: [11], totalCents: 33 },
    },
    {
      id: "multiple-lines",
      input: [
        { price: "2.675", quantity: 3 },
        { price: "0.004", quantity: 100 },
        { price: "4", quantity: 1 },
      ],
      expected: { unitCents: [268, 0, 400], totalCents: 1204 },
    },
  ],
} as const;
