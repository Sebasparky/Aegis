// FAKE DEMO DATA ONLY.
// Production must use encrypted vault storage, tokenized cards, OAuth, virtual cards, or provider APIs.
// Raw secrets must never be returned to outside agents.
// This file exists to prove the architecture: the Runner holds credentials, not the agent.

export interface CheckoutData {
  email: string;
  phone: string;
  streetAddress: string;
  city: string;
  zip: string;
  /** The <select> option value, not the display label (e.g. "US" not "United States"). */
  countryValue: string;
  cardNumber: string;
  cardExpiry: string;
  cardCvv: string;
  nameOnCard: string;
}

export function getMockCheckoutData(): CheckoutData {
  return {
    email: "demo@aegis.local",
    phone: "555-0100",
    streetAddress: "123 Aegis Test Ave",
    city: "Ann Arbor",
    zip: "48109",
    countryValue: "US",
    cardNumber: "4242424242424242",
    cardExpiry: "12/34",
    cardCvv: "123",
    nameOnCard: "Demo User",
  };
}
