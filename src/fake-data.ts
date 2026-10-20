/** Sample emails for the offline fake mode. Deliberately varied so every action is exercised. */
export interface Scenario {
  key: string;
  from: string;
  subject: string;
  body: string;
  headers?: Record<string, string>;
  /** the user has written to this sender before */
  knownContact?: boolean;
  /** what the default fake Jev and default settings should do with it */
  expect: "alert" | "keep" | "digest" | "archive";
}

export const SCENARIOS: Scenario[] = [
  {
    key: "outage",
    from: "PagerDuty <alerts@pagerduty.com>",
    subject: "[CRITICAL] Production API is down",
    body: "The production API has been failing health checks for 4 minutes. Customers cannot place orders. Acknowledge immediately.",
    expect: "alert",
  },
  {
    key: "friend",
    from: "Sam Taylor <sam.taylor@example.org>",
    subject: "Dinner on Saturday?",
    body: "Hey, are you free on Saturday night? We were thinking of trying that new place on Smith St. Let me know!",
    expect: "keep",
  },
  {
    key: "invoice",
    from: "Acme Supplies <billing@acme-supplies.com>",
    subject: "Invoice 4821 is due on Friday",
    body: "Your invoice for $2,340.00 is due this Friday. Please arrange payment by the due date to avoid a late fee. Reply if you have any questions.",
    expect: "keep",
  },
  {
    key: "review",
    from: "Alex Chen <notifications@github.com>",
    subject: "[acme/api] Add retry to webhook sender (PR #512)",
    body: "alexchen requested your review on this pull request. Could you take a look when you get a chance?",
    headers: { "list-id": "acme/api <api.acme.github.com>", "x-github-reason": "review_requested" },
    expect: "keep",
  },
  {
    key: "ci",
    from: "GitHub <notifications@github.com>",
    subject: "[acme/api] Run completed: CI (main)",
    body: "The build passed for commit 9f3c2d1 on main. View the workflow run for details.",
    headers: { "list-id": "acme/api <api.acme.github.com>", "x-github-reason": "ci_activity" },
    expect: "digest",
  },
  {
    key: "newsletter",
    from: "The Weekly Byte <newsletter@weeklybyte.io>",
    subject: "The Weekly Byte #214: Rust in production, and more",
    body: "This week's newsletter: a roundup of articles on Rust in production, a deep dive on SQLite, and our favourite links. Unsubscribe any time.",
    headers: { "list-unsubscribe": "<mailto:unsub@weeklybyte.io>", "list-id": "Weekly Byte <weekly.weeklybyte.io>" },
    expect: "archive",
  },
  {
    key: "promo",
    from: "ShoeCo <hello@shoeco.com>",
    subject: "40% off everything this weekend only",
    body: "Our biggest sale of the year. Take 40% off sitewide with code SAVE40. Shop now before it ends. Unsubscribe.",
    headers: { "list-unsubscribe": "<mailto:unsub@shoeco.com>" },
    expect: "archive",
  },
  {
    key: "promo-known",
    from: "Jordan Lee <jordan@conference-co.com>",
    subject: "Early bird discount for DevConf ends soon",
    body: "Hi, as we chatted last month, early bird tickets with a 20% discount end this week. Happy to answer questions.",
    knownContact: true,
    expect: "keep",
  },
  {
    key: "receipt",
    from: "Uber Eats <orders@ubereats.com>",
    subject: "Your order receipt",
    body: "Thanks for your order. Receipt: 1 x Pad Thai, total $24.50 charged to your card ending 4242. Your order was delivered.",
    expect: "digest",
  },
  {
    key: "security",
    from: "Google <no-reply@accounts.google.com>",
    subject: "Your verification code is 482913",
    body: "Use this verification code to sign in: 482913. If this wasn't you, secure your account.",
    expect: "keep",
  },
  {
    key: "invite",
    from: "Priya Nair <priya.nair@example.com>",
    subject: "Invitation: Sprint planning @ Tue 10am",
    body: "You have been invited to a meeting: Sprint planning, Tuesday 10:00-11:00. Calendar invitation attached. Accept or decline.",
    expect: "keep",
  },
  {
    key: "support",
    from: "Cloudflare Support <support@cloudflare.com>",
    subject: "Re: Ticket #88213 - Durable Objects billing question",
    body: "Thanks for contacting support. We've looked into your support ticket and the charge is correct. Let us know if you need anything else.",
    expect: "keep",
  },
  {
    key: "travel",
    from: "Qantas <bookings@qantas.com>",
    subject: "Your flight itinerary to Sydney",
    body: "Your booking is confirmed. Itinerary: flight QF428 Melbourne to Sydney, departing Thursday 7:05am. Check in opens 24 hours before.",
    expect: "keep",
  },
  {
    key: "social",
    from: "LinkedIn <notifications-noreply@linkedin.com>",
    subject: "Priya and 3 others liked your post",
    body: "Your post is getting attention. See who liked it and join the conversation on LinkedIn.",
    expect: "archive",
  },
  {
    key: "school",
    from: "Riverside Primary School <office@riverside-ps.example.edu>",
    subject: "Term 4 excursion permission forms",
    body: "Dear parents, permission forms for the grade 3 excursion are due next week. Please return the signed form to the school office.",
    expect: "keep",
  },
  {
    key: "colleague",
    from: "Priya Nair <priya.nair@example.com>",
    subject: "Quick question about the roadmap",
    body: "Hi, can you confirm which customer projects are in the Q1 roadmap? I need to update the deck before standup.",
    knownContact: true,
    expect: "keep",
  },
];

export const scenarioByKey = (key: string) => SCENARIOS.find((s) => s.key === key);
