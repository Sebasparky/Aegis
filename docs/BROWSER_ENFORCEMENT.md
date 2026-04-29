# BROWSER_ENFORCEMENT.md

## Purpose

This document defines how Aegis should enforce collars inside protected browser sessions.

Browser enforcement is the core technical wedge for the Aegis MVP.

The goal is not to build a custom browser.

The goal is to let outside agents use the web through an Aegis-controlled browser session, while Aegis detects and gates sensitive actions.

Core line:

> Agents can browse. Aegis decides when they can commit.

## Core Thesis

Future agents will use browsers heavily.

They will browse websites, search, scroll, compare, read, draft, fill forms, log in, post, pay, upload, and submit.

Aegis should not try to prevent agents from using the web.

Aegis should let agents browse freely while controlling moments where browsing becomes authority.

Aegis should focus on sensitive boundaries:

- login
- payment
- purchase
- subscription
- posting
- messaging
- email sending
- file upload
- form submission
- identity disclosure
- account setting changes
- OAuth authorization
- irreversible actions

Core line:

> Aegis does not restrict browsing. Aegis restricts authority.

## What Aegis Protected Sessions Are

An Aegis Protected Session is a controlled browser session that an outside agent can use.

The session should be:

- created by Aegis
- isolated from the user’s normal browser
- tied to an Aegis Pass
- tied to a collar
- short-lived
- revocable
- monitored for sensitive action boundaries
- headless by default
- visible on demand

The outside agent controls the session only through Aegis-approved browser tools or APIs.

The agent should not get access to the user’s normal Chrome profile, normal cookies, password manager, or unrestricted browser session.

## What Browser Enforcement Is

Browser enforcement means:

1. The outside agent requests a browser action.
2. Aegis inspects the action and current page context.
3. Aegis detects whether the action is sensitive.
4. Aegis evaluates the action against the active collar.
5. Aegis allows, blocks, pauses for approval, or hands the step to an Aegis Runner.
6. Aegis creates receipts for trust-relevant events.

Browser enforcement is not watching every click for curiosity.

It is controlling actions with real-world consequences.

## Recommended Technical Approach

Use Playwright-controlled Chromium for the MVP.

Do not build a custom browser UI or browser engine.

Use:

- Chromium
- Playwright
- isolated browser contexts
- headless mode for background operation
- visible mode for demo/debugging
- event hooks before actions
- DOM inspection
- URL inspection
- form inspection
- button text inspection
- network interception where useful

The Aegis browser should be infrastructure.

The product UI should be the dashboard, collar editor, approval inbox, active session view, and receipts.

## Headless vs Visible Sessions

Aegis should support both headless and visible modes.

### Headless mode

Default long-term mode.

Pros:

- clean user experience
- can run in background
- fits autonomous agents
- user only sees approvals and receipts

Cons:

- harder to debug
- some websites may block headless browsers
- user may want visibility during sensitive actions

### Visible mode

Best for MVP demos and debugging.

Pros:

- user can see what the agent is doing
- easier to demonstrate trust boundary
- easier to debug browser automation
- easier for early users to trust

Cons:

- less seamless
- may feel like a browser product

Recommended MVP approach:

- visible mode available by default for demo
- headless mode supported or planned
- “View Session” button from dashboard/approval inbox

## Session Lifecycle

### 1. Session requested

An outside agent requests a protected session through Aegis.

Request includes:

- Aegis Pass token
- task purpose
- requested collar or capability
- preferred mode

### 2. Aegis validates pass

Aegis checks:

- pass exists
- pass is active
- pass is not expired
- pass allows requested collar
- user exists
- collar exists
- collar is active

### 3. Aegis creates session

Aegis creates:

- ProtectedSession record
- Agent Session AegisID if used
- isolated browser context
- page instance
- expiration time
- initial session event

### 4. Agent controls session through Aegis

The agent can request actions:

- navigate
- click
- type
- read page
- screenshot
- close session

Aegis mediates each action.

### 5. Sensitive action detected

Aegis detects sensitive boundary.

### 6. Policy applied

Aegis evaluates the action against the collar.

### 7. Action decision

Aegis returns:

- allow
- allow_and_log
- approval_required
- runner_required
- block
- pause_session
- revoke_session

### 8. Session ends

Session ends when:

- user closes it
- agent closes it
- collar expires
- pass expires
- session expires
- user revokes access
- severe incident occurs

## Browser Tool API

The agent should not directly control Chromium.

The agent should use Aegis browser tools.

Initial tools:

- create_protected_session
- navigate
- read_page
- click
- type
- screenshot
- request_capability
- close_session

Optional later tools:

- select_option
- upload_file
- download_file
- extract_links
- extract_forms
- get_current_state
- back
- forward
- wait_for_text

## Action Flow

### Navigate

Agent requests:

navigate to URL

Aegis checks:

- is session active?
- is URL blocked by collar?
- is domain known malicious?
- is site category restricted?

If safe:

- navigate
- update current URL
- scan page for sensitive forms
- log minimal session event

### Read page

Agent requests page content.

Aegis returns:

- title
- URL
- selected text preview
- structured page summary if available

Avoid returning unnecessary sensitive data if logged-in pages contain private information.

Future versions may need content redaction.

### Click

Agent requests click.

Aegis should inspect:

- target element
- button text
- link text
- nearby text
- current URL
- form context
- page category

If low-risk:

- allow click

If sensitive:

- evaluate collar
- allow, block, or require approval

### Type

Agent requests typing into field.

Aegis should inspect:

- input type
- input name
- autocomplete value
- placeholder
- label text
- surrounding text
- value being typed
- current domain

If field is sensitive:

- evaluate collar before typing

Sensitive field examples:

- password
- email
- phone
- address
- credit card
- SSN
- passport
- DOB
- medical information
- bank account
- API key

### Submit

Form submission should be treated as potentially sensitive.

Before submit:

- inspect form fields
- classify data categories
- inspect submit button
- inspect URL
- inspect nearby text
- evaluate collar

### Upload

File uploads should be sensitive by default.

Before upload:

- classify file type if possible
- check collar file rules
- require approval unless explicitly allowed
- block high-risk file categories by default

## Sensitive Action Detection

Sensitive detection should start rule-based.

Do not overbuild AI classification in the MVP.

### URL signals

Flag URLs containing:

- login
- signin
- signup
- checkout
- cart
- payment
- billing
- subscribe
- account
- settings
- authorize
- oauth
- upload
- apply
- submit
- delete
- cancel

### Input signals

Flag inputs with:

- type=password
- type=file
- autocomplete=cc-number
- autocomplete=cc-exp
- autocomplete=cc-csc
- autocomplete=email
- autocomplete=tel
- autocomplete=street-address
- name includes ssn
- name includes passport
- name includes dob
- name includes card
- name includes bank
- name includes routing
- name includes medical

### Button text signals

Flag buttons or links containing:

- place order
- pay
- purchase
- buy now
- subscribe
- confirm
- send
- post
- publish
- submit
- apply
- upload
- delete
- cancel account
- authorize
- connect
- save payment
- agree
- accept terms

### Page text signals

Flag pages containing nearby text such as:

- total due
- recurring billing
- non-refundable
- cancellation fee
- payment method
- credit card
- social security
- passport
- driver’s license
- upload your ID
- medical history
- bank account
- authorize access

### Network signals

When possible, flag:

- POST requests to checkout/payment endpoints
- OAuth authorization requests
- file upload requests
- requests containing sensitive field names
- requests to unverified third-party payment redirects
- account setting changes

### Domain trust signals

Flag or restrict sensitive actions when:

- domain is unknown
- domain is unverified
- domain has incident reports
- domain has prompt-injection reports
- domain does not match expected business
- domain redirects unexpectedly

## Action Classification

Aegis should convert browser signals into action types.

Initial action types:

- browse
- search
- read
- compare
- add_to_cart
- login
- purchase
- payment
- subscription
- post_publicly
- comment
- direct_message
- send_email
- upload_file
- submit_form
- create_account
- share_email
- share_phone
- share_address
- identity_disclosure
- government_id_upload
- medical_data_disclosure
- financial_data_disclosure
- account_setting_change
- oauth_authorize
- delete_account
- download_file

Example:

Button text: “Place Order”  
URL: /checkout  
Payment form present  
Action type: purchase  
Risk: high

Example:

Input type: password  
URL: /login  
Action type: login  
Risk: high

Example:

Button text: “Post”  
Domain: x.com  
Action type: post_publicly  
Risk: high

Example:

Input type: file  
Nearby text: “Upload driver’s license”  
Action type: government_id_upload  
Risk: critical

## Policy Evaluation

After classification, Aegis evaluates the action against the collar.

Policy inputs:

- session
- collar
- action type
- risk level
- domain
- counterparty trust
- page context
- amount if known
- file type if known
- claim type if known
- previous decisions
- expiration status

Policy outputs:

- allow
- allow_and_log
- approval_required
- runner_required
- block
- pause_session
- revoke_session

Default rules:

- if session expired, block
- if pass revoked, block
- if collar revoked, block
- if action is in blocked_actions, block
- if action is in approval_required_actions, approval_required
- if action is in allowed_actions, allow
- if action is sensitive and unknown, approval_required
- if action is critical and unverified counterparty, block
- if repeated suspicious behavior, pause_session

## Approval Flow

When approval is required:

1. browser action pauses before execution
2. approval request is created
3. session status becomes waiting_for_approval
4. user sees approval card
5. user approves or denies
6. if approved, action resumes or Runner executes
7. if denied, action is blocked
8. receipt is created

Approval card should show:

- agent name
- action type
- website/domain
- trust status
- collar rule
- reason
- consequence of approval
- approve/deny controls

## Runner Flow

Aegis Runner should handle sensitive actions that require secrets or controlled authority.

Examples:

- login
- payment
- verified claim disclosure
- approved post
- approved email
- file upload
- form submission

Runner rules:

- receive narrow task
- receive only minimum authority
- obey collar constraints
- expire quickly
- log receipt
- terminate after task

The outside agent should receive the outcome, not the raw secret.

Core line:

> Outside agents plan. Aegis executes sensitive steps.

## What The Agent Sees

The outside agent should see:

- session ID
- allowed browser tools
- current URL
- page content or summary
- action results
- approval required status
- blocked status
- final outcome

The outside agent should not see:

- raw passwords
- raw card numbers
- full identity documents
- internal vault data
- private approval tokens
- user’s unrelated accounts
- unrestricted browser cookies

## What The User Sees

The user should see:

- active session status
- current website
- collar applied
- pending approvals
- blocked sensitive actions
- receipts
- optional browser preview

The user should not have to watch every click.

## Browser Isolation

Protected sessions should be isolated.

Use separate browser contexts.

Do not use the user’s real browser profile.

Do not inherit all cookies by default.

Do not expose unrelated logged-in accounts.

Do not persist session state longer than needed.

Session data should be destroyed when the task ends unless user explicitly saves it.

## Headless Operation

In headless mode:

- browser runs in background
- agent controls browser through Aegis tools
- user sees dashboard updates
- approvals appear when needed
- user can view screenshot or open live view if supported

Headless mode should still enforce collars.

Headless does not mean unrestricted.

## Visible Operation

In visible mode:

- browser window is shown
- useful for demos and debugging
- Aegis still mediates actions
- user can watch agent browse
- sensitive actions still pause for approval

Visible mode should not be a custom browser project.

Use Chromium window where possible.

## Screenshot and Page Content Handling

Screenshots and page content may contain private information.

For MVP:

- screenshots can be used for debugging or view session
- do not store screenshots by default
- avoid storing full page content in receipts
- store screenshots only for high-risk receipts or user-requested reports

Long-term:

- redact sensitive fields
- allow user-controlled retention
- separate live preview from stored evidence

## Network Interception

Network interception can strengthen enforcement.

Possible uses:

- detect POST requests
- detect checkout/payment endpoints
- detect file uploads
- detect OAuth authorization
- block requests before they leave
- inspect request metadata

Do not rely only on network interception.

Network requests often lack enough semantic context.

Combine network signals with DOM and policy context.

## Limitations

Browser enforcement has limits.

Aegis may struggle with:

- CAPTCHAs
- passkeys
- 2FA
- anti-bot systems
- shadow DOM
- iframes
- canvas UIs
- heavily obfuscated web apps
- remote desktop agents
- agents using uncontrolled browsers
- websites that block automation
- ambiguous button text
- malicious websites hiding intent

Be honest about these limits.

Aegis protects sessions it controls.

Aegis cannot fully protect activity outside Aegis-controlled sessions.

## Security Claims

Good claim:

> Aegis gates sensitive actions inside protected agent sessions.

Good claim:

> Aegis keeps raw secrets away from outside agents when actions are routed through Aegis.

Good claim:

> Aegis can require approval before login, payment, posting, uploading, submitting, or identity disclosure.

Avoid claim:

> Aegis prevents all bad agent behavior.

Avoid claim:

> Aegis stops every prompt injection.

Avoid claim:

> Aegis controls agents outside Aegis sessions.

## MVP Browser Scope

The MVP should support:

- create protected session
- navigate
- read page
- click by text or selector
- type by selector
- detect checkout/payment/login/post/upload/submit
- evaluate collar
- pause for approval
- resume or block
- create receipt

The MVP can use:

- mock store
- visible Chromium
- basic headless mode
- simple rule-based detector
- simulated Runner

The MVP does not need:

- all websites
- real payment
- real password vault
- real identity verification
- production browser hardening
- perfect detection
- anti-bot bypass
- full extension support

## Mock Store Recommendation

Use a mock store for the first demo.

Why:

- real websites are unpredictable
- automation may be blocked
- checkout flows vary
- payment should be simulated
- demo needs reliability

Mock store pages:

- home
- search results
- product page
- cart
- checkout
- confirmation

Sensitive elements:

- email field
- phone field
- shipping address
- credit card input
- subscription checkbox
- upload ID field
- place order button

This lets Aegis show enforcement clearly.

## Future Browser Directions

Future versions may include:

- MCP browser tool
- browser extension
- cloud protected browser
- local protected browser app
- mobile approval integration
- website AegisID policy discovery
- credential vault integration
- OAuth session handoff
- anti-phishing checks
- prompt injection scanning
- canary tokens
- visual risk classifier
- domain reputation network
- business verification integration

## Implementation Notes

Suggested internal services:

- BrowserSessionService
- BrowserActionService
- SensitiveActionDetector
- PolicyService
- ApprovalService
- RunnerService
- ReceiptService

Suggested browser action structure:

{
  "session_id": "sess_123",
  "action": "click",
  "target": {
    "type": "text",
    "value": "Place Order"
  }
}

Suggested detection result:

{
  "action_type": "purchase",
  "risk_level": "high",
  "reason": "Clicked Place Order on checkout page.",
  "signals": ["button_text", "checkout_url", "payment_form_present"]
}

Suggested policy result:

{
  "decision": "approval_required",
  "reason": "Purchases require approval under this collar."
}

## User Experience Principle

Browser enforcement should feel invisible until it matters.

The agent should not feel blocked during normal work.

The user should not feel spammed.

Aegis should appear at moments of consequence.

Core UX line:

> Browse freely. Commit safely.

## Core Lines To Preserve

- Agents can browse. Aegis decides when they can commit.
- Aegis does not restrict browsing. Aegis restricts authority.
- Aegis protects sessions it controls.
- The outside agent controls the session only through Aegis-approved browser tools.
- The model can think whatever it wants. Aegis controls what it can do.
- Outside agents plan. Aegis executes sensitive steps.
- Browse freely. Commit safely.


