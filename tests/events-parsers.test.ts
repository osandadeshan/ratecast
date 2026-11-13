import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays } from "@/lib/dates";
import {
  classifyCbsl,
  classifyFomc,
  classifyImf,
  parseCbslList,
  parseCbslNextDate,
  parseBlsSchedule,
  parseCbslRss,
  parseFomcJson,
  parseFomcPage,
} from "@/lib/sources/events";

const row = (month: string, days: string) =>
  `<div class="row"><div class="fomc-meeting__month"><strong>${month}</strong></div><div class="fomc-meeting__date">${days}</div>` +
  `<div>Statement: <a href="/x.pdf">PDF</a> | <a href="/x.htm">HTML</a></div><div>(Released February 21, 2024)</div></div>`;

const FOMC_PAGE = `<html><head><script>var x = "2019 FOMC Meetings";</script><style>.a{}</style></head><body>
<p>Market</p><p>12</p>
<h4><a id="42">2024 FOMC Meetings</a></h4>
${row("January", "30-31")}
${row("March", "19-20*")}
${row("Apr/May", "30-1")}
${row("August", "22 (notation vote)")}
${row("September", "15 (unscheduled)")}
${row("October", "8-9 (cancelled)")}
${row("Market", "12")}
<h4>2027 FOMC Meetings</h4>
${row("January", "26-27")}
${row("June", "8-9*")}
<p>* Meeting associated with a Summary of Economic Projections.</p>
</body></html>`;

test("parseFomcPage reads the decision day of each meeting, per year section", () => {
  const dates = parseFomcPage(FOMC_PAGE).map((e) => e.eventDate);
  assert.deepEqual(dates, ["2024-01-31", "2024-03-20", "2024-05-01", "2024-09-15", "2027-01-27", "2027-06-09"]);
});

test("parseFomcPage: cross-month meeting ends in the second month", () => {
  assert.ok(parseFomcPage(FOMC_PAGE).some((e) => e.eventDate === "2024-05-01"));
});

test("parseFomcPage: notation votes, cancelled meetings and look-alike words are skipped", () => {
  const dates = parseFomcPage(FOMC_PAGE).map((e) => e.eventDate);
  assert.ok(!dates.includes("2024-08-22"));
  assert.ok(!dates.some((d) => d.startsWith("2024-10")));
  assert.ok(!dates.some((d) => d.endsWith("-12"))); // "Market 12" is not "March 12"
  assert.ok(!dates.some((d) => d.startsWith("2019"))); // text inside <script> is ignored
});

test("parseFomcPage: scheduled meetings are known 300 days ahead, unscheduled only on the day", () => {
  const ev = parseFomcPage(FOMC_PAGE);
  const jan = ev.find((e) => e.eventDate === "2024-01-31")!;
  assert.equal(jan.kind, "fomc");
  assert.equal(jan.knownSince, addDays("2024-01-31", -300));
  const unscheduled = ev.find((e) => e.eventDate === "2024-09-15")!;
  assert.equal(unscheduled.knownSince, "2024-09-15");
  assert.match(unscheduled.title, /unscheduled/);
});

test("parseFomcPage returns nothing for an unrelated page", () => {
  assert.deepEqual(parseFomcPage("<html><title>Maintenance</title><p>January</p><p>30-31</p></html>"), []);
});

test("parseFomcJson keeps only 'FOMC Meeting' entries and takes the last day", () => {
  const cal = {
    events: [
      { type: "FOMC", title: "FOMC Meeting", month: "2026-12", days: "9" },
      { type: "FOMC", title: " FOMC meeting ", month: "2026-01", days: "27-28" },
      { type: "FOMC", title: "FOMC Minutes", month: "2026-11", days: "18" },
      { type: "FOMC", title: "FOMC Press Conference", month: "2026-12", days: "9" },
      { type: "Speeches", title: "FOMC Meeting", month: "2026-11", days: "13" },
      { type: "FOMC", title: "FOMC Meeting", days: "5" },
      { type: "FOMC", title: "FOMC Meeting", month: "2026-03", days: "" },
    ],
  };
  const ev = parseFomcJson(cal);
  assert.deepEqual(ev.map((e) => e.eventDate), ["2026-12-09", "2026-01-28"]);
  assert.ok(ev.every((e) => e.kind === "fomc" && e.knownSince === addDays(e.eventDate, -300)));
  assert.deepEqual(parseFomcJson({ events: [] }), []);
});

test("parseCbslList reads review dates from PDF file names, de-duplicated and sorted", () => {
  const html = `
    <a target="_blank" href="https://www.cbsl.gov.lk/sites/default/files/cbslweb_documents/press/pr/press_20260930_Monetary_Policy_Review_No_5_2026_e_1994aj.pdf">Monetary Policy Review - No. 5 of 2026</a>
    <a href="https://www.cbsl.gov.lk/sites/default/files/cbslweb_documents/press/pr/press_20260930_Monetary_Policy_Review_No_5_2026_e_1994aj.pdf">again</a>
    <a href="/sites/default/files/cbslweb_documents/press/pr/press_20250129_Monetary_Policy_Review_No_1_2025_e_Fz9.pdf">No. 1 of 2025</a>
    <a href="/sites/default/files/press_20260101_Some_Other_Release_e.pdf">other</a>`;
  const list = parseCbslList(html);
  assert.deepEqual(list.map((r) => r.date), ["2025-01-29", "2026-09-30"]);
  assert.equal(
    list[0].url,
    "https://www.cbsl.gov.lk/sites/default/files/cbslweb_documents/press/pr/press_20250129_Monetary_Policy_Review_No_1_2025_e_Fz9.pdf",
  );
  assert.deepEqual(parseCbslList("<html>Maintenance</html>"), []);
});

test("parseCbslNextDate finds the next review date, even with broken spacing", () => {
  assert.equal(
    parseCbslNextDate("The release of the next regular statement on the monetary policy review will be on 20 November 2026."),
    "2026-11-20",
  );
  assert.equal(
    parseCbslNextDate("The   release of the nex t regular  state ment on the monetary policy review will be on  2 0  Nove mber 2026."),
    "2026-11-20",
  );
  assert.equal(parseCbslNextDate("The next statement is scheduled for 5 March, 2027."), "2027-03-05");
});

test("parseCbslNextDate returns null when no next date is named (year-end statement)", () => {
  assert.equal(parseCbslNextDate("The Central Bank of Sri Lanka keeps the Overnight Policy Rate (OPR) unchanged."), null);
  assert.equal(parseCbslNextDate(""), null);
});

test("classifyFomc: cut / hold / hike from the statement sentence", () => {
  const wrap = (s: string) => `<div id="article"><p>${s}</p></div>`;
  assert.equal(
    classifyFomc(wrap("the Committee decided to lower the target range for the federal funds rate by 1/4 percentage point to 4 to 4-1/4 percent.")),
    "cut",
  );
  assert.equal(
    classifyFomc(wrap("the Committee decided to maintain the target\n range for the federal funds rate at 3-3/4 to 4 percent.")),
    "hold",
  );
  assert.equal(classifyFomc(wrap("the Committee decided to raise the <em>target range</em> for the federal funds rate")), "hike");
  assert.equal(classifyFomc(wrap("the Committee decided to increase the target range")), "hike");
  assert.equal(classifyFomc(wrap("The Federal Reserve announced the approval of an application.")), null);
});

test("classifyCbsl: reads the headline before 'The Monetary Policy Board'", () => {
  const doc = (headline: string) =>
    `1 Monetary Policy Review: No. 05 The Central Bank of Sri Lanka ${headline} The Monetary Policy Board, at its meeting held yesterday, decided`;
  assert.equal(classifyCbsl(doc("keeps the Overnight Policy Rate (OPR) unchanged")), "hold");
  assert.equal(classifyCbsl(doc("maintains the policy rate at the current level")), "hold");
  assert.equal(classifyCbsl(doc("further reduces the Overnight Policy Rate (OPR)")), "cut");
  assert.equal(classifyCbsl(doc("introduces the Overnight Policy Rate and further eases its monetary policy stance")), "cut");
  assert.equal(classifyCbsl(doc("raises the Overnight Policy Rate (OPR)")), "hike");
});

test("classifyCbsl: 'increases' is a hike even though it contains 'eases'", () => {
  const text =
    "The Central Bank of Sri Lanka increases the Overnight Policy Rate (OPR) The Monetary Policy Board decided to increase the OPR";
  assert.equal(classifyCbsl(text), "hike");
  // spacing broken by PDF extraction
  assert.equal(classifyCbsl("The Cen tral Bank of Sri  Lanka incr eases the OPR The Monetary Policy Board"), "hike");
});

test("classifyCbsl: only the headline counts, and unknown wording gives null", () => {
  // "decided to reduce" appears after the headline boundary and must not turn a hold into a cut
  assert.equal(
    classifyCbsl("The Central Bank of Sri Lanka keeps the OPR unchanged The Monetary Policy Board noted that it reduces risks"),
    "hold",
  );
  assert.equal(classifyCbsl("The Central Bank of Sri Lanka publishes its annual report The Monetary Policy Board"), null);
  assert.equal(classifyCbsl("Some unrelated press release about pyramid schemes"), null);
});

test("classifyImf: staff-level agreement, board approval, other", () => {
  assert.equal(classifyImf("IMF Reaches Staff-Level Agreement on the Fifth Review of Sri Lanka's EFF"), "sla");
  assert.equal(classifyImf("IMF and Sri Lanka reach staff level agreement"), "sla");
  assert.equal(classifyImf("IMF Executive Board Completes the Fourth Review under the EFF"), "board");
  assert.equal(classifyImf("IMF approves disbursement of US$ 350 million"), "board");
  assert.equal(classifyImf("IMF mission visits Colombo"), "other");
});

const RSS = `<?xml version="1.0"?><rss><channel><title>Central Bank of Sri Lanka</title>
<item><title>IMF Executive Board Completes the Fifth Review &amp; Approves Disbursement</title>
<link>https://www.cbsl.gov.lk/en/news/imf-fifth-review</link><pubDate>Fri, 30 Oct 2026 20:31:08 +0000</pubDate></item>
<item><title><![CDATA[Sri Lanka reaches Staff-Level Agreement with the International Monetary Fund]]></title>
<link>https://www.cbsl.gov.lk/en/node/1</link><pubDate>Tue, 06 Oct 2026 04:00:00 +0000</pubDate></item>
<item><title>CCPI-based headline inflation accelerated in October 2026</title>
<link>https://www.cbsl.gov.lk/en/news/ccpi</link><pubDate>Fri, 30 Oct 2026 14:31:08 +0000</pubDate></item>
<item><title>IMF statement with a broken date</title><link>https://x</link><pubDate>not a date</pubDate></item>
</channel></rss>`;

test("parseCbslRss keeps IMF items only, dated in Sri Lanka time, with an outcome", () => {
  const ev = parseCbslRss(RSS);
  assert.equal(ev.length, 2);
  // 20:31 UTC is 02:01 the next day in Colombo (UTC+5:30)
  assert.deepEqual(
    { kind: ev[0].kind, eventDate: ev[0].eventDate, knownSince: ev[0].knownSince, outcome: ev[0].outcome, url: ev[0].url },
    { kind: "imf", eventDate: "2026-10-31", knownSince: "2026-10-31", outcome: "board", url: "https://www.cbsl.gov.lk/en/news/imf-fifth-review" },
  );
  assert.equal(ev[0].title, "IMF Executive Board Completes the Fifth Review & Approves Disbursement");
  assert.equal(ev[1].eventDate, "2026-10-06");
  assert.equal(ev[1].outcome, "sla");
  assert.equal(ev[1].title, "Sri Lanka reaches Staff-Level Agreement with the International Monetary Fund");
});

test("parseCbslRss returns nothing for a feed without IMF items", () => {
  assert.deepEqual(parseCbslRss("<rss><channel><item><title>PMI expanded</title><pubDate>Fri, 30 Oct 2026 11:31:50 +0000</pubDate></item></channel></rss>"), []);
  assert.deepEqual(parseCbslRss(""), []);
});

const blsRow = (day: string, name: string, ref: string) =>
  `<tr class="release-list-odd-row">\n<td class="date-cell"><p>${day}</p></td>\n<td class="time-cell"><p>08:30 AM</p></td>\n` +
  `<td class="desc-cell"><p><strong>${name}</strong> for ${ref}</p></td></tr>\n`;

test("parseBlsSchedule: CPI and jobs dates, exact release names only", () => {
  const html =
    `<table>` +
    blsRow("Friday, January 10, 2025", "Employment Situation", "December 2024") +
    blsRow("Wednesday, January 15, 2025", "Consumer Price Index", "December 2024") +
    blsRow("Thursday, March 20, 2025", "Employment Situation of Veterans", "Annual 2024") +
    blsRow("Thursday, December 18, 2025", "Consumer Price Index", "November 2025") +
    blsRow("Friday, January 31, 2025", "Employment Cost Index", "Fourth Quarter 2024") +
    `</table>`;
  const ev = parseBlsSchedule(html, "https://www.bls.gov/schedule/2025/home.htm");
  assert.deepEqual(
    ev.map((e) => `${e.kind} ${e.eventDate} ${e.knownSince}`),
    // 18 Dec is outside CPI's usual 10th–15th (moved by the 2025 shutdown): known only a week ahead.
    ["us_jobs 2025-01-10 2024-12-01", "us_cpi 2025-01-15 2024-12-01", "us_cpi 2025-12-18 2025-12-11"],
  );
  assert.equal(parseBlsSchedule("<html>maintenance</html>", "x").length, 0);
});
