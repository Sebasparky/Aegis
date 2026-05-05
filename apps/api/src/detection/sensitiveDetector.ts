import type { ActionType, RiskLevel } from "@aegis/types";

export interface DetectionInput {
  action: "click" | "type";
  url?: string;
  targetText?: string;
  elementInfo?: {
    tagName?: string;
    inputType?: string;
    id?: string;
    name?: string;
    autocomplete?: string;
    placeholder?: string;
  };
  pageText?: string;
}

export interface DetectionResult {
  sensitive: boolean;
  action_type: ActionType;
  risk_level: RiskLevel;
  reason: string;
  signals: string[];
}

function ok(
  action_type: ActionType,
  risk_level: RiskLevel,
  reason: string,
  signals: string[]
): DetectionResult {
  return { sensitive: true, action_type, risk_level, reason, signals };
}

const NONE: DetectionResult = {
  sensitive: false,
  action_type: "browse",
  risk_level: "low",
  reason: "No sensitive action detected.",
  signals: [],
};

export function detect(input: DetectionInput): DetectionResult {
  const { action, url = "", elementInfo = {}, pageText = "" } = input;
  const text = (input.targetText ?? "").toLowerCase().trim();
  const urlLower = url.toLowerCase();
  const name = (elementInfo.name ?? "").toLowerCase();
  const id = (elementInfo.id ?? "").toLowerCase();
  const autocomplete = (elementInfo.autocomplete ?? "").toLowerCase();
  const placeholder = (elementInfo.placeholder ?? "").toLowerCase();
  const inputType = (elementInfo.inputType ?? "").toLowerCase();

  if (action === "click") {
    // Purchase: "Place Order" button or checkout URL + order-related text
    if (text.includes("place order") || (urlLower.includes("checkout") && text.includes("order"))) {
      return ok("purchase", "high", 'Detected "Place Order" click — likely purchase action.', [
        `text="${input.targetText}"`,
        url ? `url=${url}` : "",
      ].filter(Boolean));
    }

    // Purchase: buy now
    if (text === "buy" || text.includes("buy now")) {
      return ok("purchase", "high", 'Detected "Buy Now" click.', [`text="${input.targetText}"`]);
    }

    // Payment: pay button
    if (text === "pay" || text.includes("pay now") || /pay \$/.test(text)) {
      return ok("payment", "high", 'Detected payment click.', [`text="${input.targetText}"`]);
    }

    // Subscription: text OR element name/id contains subscribe/subscription
    if (
      text.includes("subscribe") ||
      name.includes("subscri") ||
      id.includes("subscri")
    ) {
      return ok("subscription", "high", "Detected subscription action.", [
        text ? `text="${input.targetText}"` : "",
        name ? `name="${elementInfo.name}"` : "",
        id ? `id="${elementInfo.id}"` : "",
      ].filter(Boolean));
    }

    // Public post
    if (text.includes("post") || text.includes("publish") || text.includes("tweet")) {
      return ok("post_publicly", "high", "Detected public post/publish action.", [`text="${input.targetText}"`]);
    }

    // Send email or message
    if (text.includes("send")) {
      const atype: ActionType = urlLower.includes("mail") ? "send_email" : "direct_message";
      return ok(atype, "medium", `Detected send action — classified as ${atype}.`, [
        `text="${input.targetText}"`,
        url ? `url=${url}` : "",
      ].filter(Boolean));
    }

    // File upload
    if (text.includes("upload")) {
      return ok("upload_file", "high", "Detected upload action.", [`text="${input.targetText}"`]);
    }

    // Form submit
    if (text === "submit" || text.includes("submit")) {
      return ok("submit_form", "medium", "Detected form submission.", [`text="${input.targetText}"`]);
    }

    // Payment method / card persistence
    // TODO(v2): Also inspect nearby label text and checkbox state — many "save card" controls
    // are checkboxes where targetText may be blank; nearby DOM text must be checked then.
    if (
      text.includes("save card") ||
      text.includes("save this card") ||
      text.includes("remember this card") ||
      text.includes("save payment method") ||
      text.includes("set as default payment")
    ) {
      return ok("save_payment_method", "high", "Detected payment persistence action — requires separate approval.", [
        `text="${input.targetText}"`,
      ]);
    }

    // Credential / session persistence ("remember me", "trust this device", etc.)
    // TODO(v2): Also inspect label text and aria-label — these controls often have blank targetText.
    if (
      text.includes("save password") ||
      text.includes("remember me") ||
      text.includes("keep me signed in") ||
      text.includes("trust this device") ||
      text.includes("don't ask again") ||
      text.includes("one-click checkout")
    ) {
      return ok("save_credential", "high", "Detected credential or session persistence action — requires separate approval.", [
        `text="${input.targetText}"`,
      ]);
    }

    return NONE;
  }

  // ── Type detection ─────────────────────────────────────────────────────────

  // Password field → login
  if (inputType === "password") {
    return ok("login", "high", "Detected password field — likely login or account creation.", [
      "inputType=password",
    ]);
  }

  // Credit card fields
  if (
    autocomplete.startsWith("cc-") ||
    name.includes("cc-") ||
    name.includes("card") ||
    name === "cc-number"
  ) {
    return ok("payment", "critical", "Detected payment card field.", [
      autocomplete ? `autocomplete=${autocomplete}` : "",
      name ? `name=${name}` : "",
    ].filter(Boolean));
  }

  // Email
  if (autocomplete === "email" || name.includes("email")) {
    return ok("share_email", "medium", "Detected email input — will share email address.", [
      autocomplete ? `autocomplete=${autocomplete}` : "",
      name ? `name=${name}` : "",
    ].filter(Boolean));
  }

  // Phone
  if (autocomplete === "tel" || name.includes("phone") || name.includes("tel")) {
    return ok("share_phone", "medium", "Detected phone number input.", [
      autocomplete ? `autocomplete=${autocomplete}` : "",
      name ? `name=${name}` : "",
    ].filter(Boolean));
  }

  // Street address
  if (autocomplete === "street-address" || name.includes("address") || name.includes("street")) {
    return ok("share_address", "medium", "Detected street address input.", [
      autocomplete ? `autocomplete=${autocomplete}` : "",
      name ? `name=${name}` : "",
    ].filter(Boolean));
  }

  // Government ID / sensitive identity fields
  const idTerms = ["ssn", "passport", "government_id", "govt_id", "driver", "license"];
  const haystack = `${name} ${placeholder}`;
  if (idTerms.some((t) => haystack.includes(t))) {
    return ok("government_id_upload", "critical", "Detected government ID or sensitive identity field.", [
      name ? `name=${name}` : "",
      placeholder ? `placeholder=${placeholder}` : "",
    ].filter(Boolean));
  }

  return NONE;
}
