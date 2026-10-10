// Everything the page says, in one place. Claims come from the repository's
// README; the bakery figures are the console's synthetic sample data.

export const NAV_LINKS = [
  { id: "issues", label: "The problem" },
  { id: "how", label: "How it works" },
  { id: "example", label: "Example" },
  { id: "safeguards", label: "Safeguards" },
  { id: "status", label: "Status" },
] as const;

export const FACTS = ["Six hazards", "0.1° grid of India", "~30 years of history", "7-day forecast", "Bank stays in charge"];

export const ISSUES = [
  {
    title: "Two identical balance sheets, two very different risks",
    problem: "A ground-floor shop on a street that waterlogs and the same shop on a raised plinth look the same on paper.",
    answer: "Scores the exact point on a 0.1° grid, and how this business's premises and trade respond to each hazard.",
  },
  {
    title: "Climate data is not built for a loan officer",
    problem: "Weather archives, climate projections, river discharge and forecasts live in different places, at different resolutions, in units no credit committee reads.",
    answer: "Folds them into one grade, A to E, with a plain-language reason for every hazard.",
  },
  {
    title: "A risk number nobody can explain",
    problem: "A black-box score cannot be defended to a credit committee, an auditor or the borrower.",
    answer: "Rules decide the score; every point it moves comes with the hazard, the shock and the DSCR behind it.",
  },
  {
    title: "The bank hears about the flood when the EMI bounces",
    problem: "After disbursal, nobody watches the forecast at the borrower's location.",
    answer: "A monitor checks every authorised loan's cell every 15 minutes, and more often when the forecast worsens.",
  },
  {
    title: "Owners get no warning and no plan",
    problem: "A district rain bulletin does not tell a baker to lift the flour off the floor tonight.",
    answer: "Emails the owner ranked, specific steps before the window, after checking consent and a cooldown.",
  },
  {
    title: "Restructuring after damage is slow and ad hoc",
    problem: "Working out what relief a damaged business can actually carry takes rounds of back-and-forth.",
    answer: "The advisor recomputes cash flow from the damage report and proposes repayment options. A bank officer decides.",
  },
];

export const STEPS = [
  {
    service: "Input service · classifier",
    title: "The business applies",
    body: "Profile, location, operations, suppliers and contacts are validated, and stored only with consent. A classifier reads the description and says, for each hazard, how much of the business stops and how customers react.",
    points: ["Nothing is stored without data-processing consent", "Two values per hazard: physical impact and demand", "Falls back to sector defaults if the model fails"],
  },
  {
    service: "Climate pipeline",
    title: "Its location gets a grade",
    body: "The point is snapped to grid cells and screened for river flood, flash flood, heat, drought, storm and cold wave against about 30 years of history. Then the 7-day forecast is read and the result is graded.",
    points: ["History from the ERA5 archive at 0.1°, from 1995", "River discharge at 0.05°, with a 30-day forecast", "Weather data from Open-Meteo; every response is kept"],
  },
  {
    service: "Finance service",
    title: "The score is stress-tested",
    body: "Six sub-scores make the baseline: DSCR, runway, leverage, revenue volatility, repayment record and business age. Each hazard in the cell is then applied as a revenue shock, insurance is netted off, and the climate-adjusted score names the driver behind every point.",
    points: ["Flags a breach when stressed DSCR falls below 1", "Good weather adds at most 3 points", "An evaluator checks climate and finance agree before rating"],
  },
  {
    service: "Monitor · alert worker",
    title: "The bank authorises; the cell is watched",
    body: "Authorising stores the finance profile and puts the business on the watch list. When the forecast crosses a danger threshold, the monitor queues an alert; a separate worker sends it after its own checks.",
    points: ["Checked every 15 minutes, more often as it worsens", "Consent and opt-out checked before each email", "6-hour cooldown per business, hazard and audience"],
  },
  {
    service: "Advisor",
    title: "An event hits; the advisor helps",
    body: "The advisor follows the loan through three modes: pre-loan advice, alert guidance and a recovery plan after damage. It proposes options such as a moratorium, a tenure extension or a bridge to an insurance payout.",
    points: ["Every number must trace to a tool result", "It can only propose; a bank officer accepts", "Runs on rules alone when no AI key is set"],
  },
];

export const DRIVERS = [
  { points: "−11.2", hazard: "Flash flood", detail: "DSCR 2.31 → 0.76 after flood and stock insurance", breach: true },
  { points: "−4", hazard: "Storm", detail: "DSCR 2.31 → 1.21", breach: false },
  { points: "−1.6", hazard: "River flood", detail: "DSCR 2.31 → 1.44", breach: false },
];

export const GRADES = [
  { grade: "A", name: "Stable" },
  { grade: "B", name: "Watch" },
  { grade: "C", name: "Exposed" },
  { grade: "D", name: "High · 0.56" },
  { grade: "E", name: "Critical" },
] as const;

export const EXAMPLE_FACTS = [
  ["Primary hazards", "Flash flood, storm"],
  ["Forecast event", "Flash flood · warning"],
  ["After the flood", "9 days closed"],
  ["Losses", "₹60,000 + ₹25,000"],
  ["Recommended", "3-month moratorium"],
  ["Decision", "Accepted by bank"],
] as const;

export const SAFEGUARDS = [
  { area: "Climate agent", title: "Raise-only", body: "An optional AI review may raise a hazard's category where gridded data misses something, such as cyclone gusts on a coast. It can never lower one." },
  { area: "Finance score", title: "Capped upside", body: "Favourable weather adds at most 3 points. Good weather never rescues a weak business." },
  { area: "Advisor", title: "Cited, never lenient", body: "Every number in an answer must match a tool result. A verdict may be stricter than the numbers imply, never more lenient." },
  { area: "Alerts", title: "Consent first", body: "No email without consent or after an opt-out, and a cooldown so owners are not buried in warnings." },
  { area: "Bank control", title: "Officers decide", body: "Only a bank officer can authorise a loan, override a weather profile or accept a repayment proposal. The officer is taken from the session, never from a form." },
  { area: "Audit", title: "Append-only trail", body: "Every write and every refusal is recorded. Request bodies, tokens and financial values are never stored, and the database refuses edits and deletes." },
];

export const AUDIENCES = [
  {
    who: "Bank officer",
    title: "Underwrite and monitor with the weather in the file",
    points: ["A climate grade and a stress-tested score for each application", "An evaluation that flags when climate and finance disagree", "Alerts for the borrowers you have authorised", "Repayment proposals to accept or reject"],
  },
  {
    who: "Business owner",
    title: "Know what the weather means for your shop",
    points: ["Advice before you take the loan", "Specific steps before heavy rain, a storm or a heatwave", "A recovery plan worked out from what you actually lost", "Your data shared with the bank only with your consent"],
  },
];

export const STATUS = [
  { part: "Climate risk API", note: "Six hazards, grading and the 7-day forecast, with its test suite passing." },
  { part: "Finance service", note: "Baseline and climate-adjusted scores, rule-based so every point can be explained." },
  { part: "Evaluator", note: "Checks climate and finance together and gives one rating with reasons." },
  { part: "Monitor and alerts", note: "Watches every authorised loan and emails the owner and the bank. Dry run by default; live sending needs SMTP settings." },
  { part: "Advisor", note: "Runs a rule-based planner without an AI key, or a language model with one." },
  { part: "ML service", note: "Alert calibration, cash-flow anomaly detection and a cash-flow simulation, served through the API. The Analysis page shows the cash-flow outlook." },
  { part: "Web app", note: "The Playground follows one loan in eight chapters. The Analysis page gives an owner one analysis with the advisor beside it." },
];

// The only limits the page names: scale of data, compute and servers.
export const LIMITS = [
  { area: "Data", title: "Big data", body: "The scores and models run on public weather records and example businesses. Calibrating them for a bank needs its loan book and repayment history at scale." },
  { area: "Compute", title: "Agent orchestration", body: "The climate agent, the classifier and the advisor each answer one request at a time. Running them side by side across a whole portfolio needs more compute." },
  { area: "Infrastructure", title: "Server and memory", body: "It runs on one machine with Postgres and Redis, on the weather provider's free allowance. Serving many banks needs more servers, more memory and a paid data feed." },
];

export const FAQ = [
  { q: "Where does the weather data come from?", a: "Open-Meteo: the ERA5 archive for history, two high-resolution climate models for projections, the forecast API for the next 7 days and the flood API for river discharge. Its free tier needs no key." },
  { q: "Does it need OpenAI or another AI service?", a: "No. Without a key, the climate screening, the finance score and the advisor all run on rules. A key adds an optional review of each location and model-written advice, still bound by the same limits." },
  { q: "Can the bank override what the model says?", a: "Yes. A bank officer can override a business's weather-impact profile with a reason, and can reject any repayment proposal. The model never moves a loan on its own." },
  { q: "How long does a first lookup take?", a: "A new location downloads about 30 years of daily history and can take up to a minute. After that it is served from the cache." },
  { q: "Is the business in the video real?", a: "No. Sri Lakshmi Bakery is made up for the console's sample mode, so the whole workflow can be seen without the API running." },
];
