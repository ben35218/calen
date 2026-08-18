import WidgetKit
import SwiftUI

// Calen "Today" widget. Renders the day's events from the JSON snapshot the
// app writes into the App Group container (lib/widgetSnapshot.ts via
// modules/calen-widget) — the widget holds no E2EE keys and never talks to the
// server, so that snapshot is its entire world.
//
// The snapshot covers a rolling 14-day window, and the timeline below emits an
// entry at each local midnight (plus each of today's event ends, so finished
// events fall off during the day). That is what makes the widget self-advance
// for up to two weeks without the app being opened. Three degraded states,
// deliberately distinct:
//   • day inside coverage, no items  → "No events today" — or "No more events
//     today" when the day HAD events that have all ended (finished events drop
//     off during the day; "No events today" at 5pm reads as data loss)
//   • day beyond the snapshot's end  → "Open Calen to update" (data is STALE —
//     never render a stale gap as a reassuring empty day)
//   • no snapshot at all (fresh install / signed out) → "Open Calen" placeholder
//
// Styling follows Apple's own Calendar widget: a bold weekday/day header,
// timed events as calendar-colour-tinted chips (colour bar + title + compact
// time range, all in the calendar colour), all-day items as ONE-LINE chips in
// the same dress with their kind trailing ("All day", "Chore", …), and — on
// medium/large — upcoming days under "TOMORROW" / "MONDAY, AUG 17" eyebrows.
//
// Layout law: content is planned against an explicit LINE BUDGET per family
// (a timed chip costs 2 lines; an all-day chip, an eyebrow, and a "+N more"
// tail cost 1), so the widget never emits a chip it can't fully show — no
// clipped half-chips at the bottom edge, and the date header is laid out
// first and NEVER moves or shrinks because of content below it. On medium,
// today's events OUTRANK upcoming days: overflow from the left column spills
// into the right column, and tomorrow-and-later only get whatever is left.

// MARK: - Snapshot model (mirrors WidgetSnapshot in lib/widgetSnapshot.ts)

struct SnapshotTimedRow: Decodable, Hashable {
    let title: String
    let color: String
    let startMin: Int
    let endMin: Int
    let struck: Bool?
}

struct SnapshotAllDayRow: Decodable, Hashable {
    let title: String
    let color: String
    let kind: String
    let struck: Bool?
}

struct SnapshotDay: Decodable {
    let date: String // yyyy-MM-dd, device-local
    let allDay: [SnapshotAllDayRow]
    let timed: [SnapshotTimedRow]
}

struct CalendarSnapshot: Decodable {
    let version: Int
    let generatedAt: String
    let startDate: String
    let endDate: String
    let days: [SnapshotDay]
}

let appGroupId = "group.app.householdcalendar.mobile"
let snapshotFilename = "widget-snapshot.json"

func loadSnapshot() -> CalendarSnapshot? {
    guard
        let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupId),
        let data = try? Data(contentsOf: container.appendingPathComponent(snapshotFilename)),
        let snap = try? JSONDecoder().decode(CalendarSnapshot.self, from: data),
        snap.version == 1
    else { return nil }
    return snap
}

// MARK: - Date helpers

func dayKey(_ date: Date) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: date)
}

func dateFromKey(_ key: String) -> Date? {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    return f.date(from: key).map { Calendar.current.startOfDay(for: $0) }
}

func minutesIntoDay(_ date: Date) -> Int {
    Int(date.timeIntervalSince(Calendar.current.startOfDay(for: date)) / 60)
}

// The instant `minutes` after `date`'s local midnight — the exact inverse of
// the app's minutesInto(), so times survive DST-change days unchanged.
func instant(onDayOf date: Date, minutes: Int) -> Date {
    Calendar.current.startOfDay(for: date).addingTimeInterval(TimeInterval(minutes * 60))
}

// Locale-aware compact range, in Apple's widget style: "4–5 PM", "9:30–10 AM".
// DateIntervalFormatter handles the localization; stripping ":00" gives the
// on-the-hour compression Apple's widget uses (harmless in locales without it).
func timeRangeLabel(onDayOf date: Date, startMin: Int, endMin: Int) -> String {
    let f = DateIntervalFormatter()
    f.dateStyle = .none
    f.timeStyle = .short
    let s = instant(onDayOf: date, minutes: startMin)
    let e = instant(onDayOf: date, minutes: min(endMin, 24 * 60))
    return f.string(from: s, to: e).replacingOccurrences(of: ":00", with: "")
}

// "TOMORROW", else "SATURDAY, AUG 15" — the eyebrow over an upcoming day.
func upcomingHeader(for date: Date) -> String {
    if Calendar.current.isDateInTomorrow(date) { return "TOMORROW" }
    let f = DateFormatter()
    f.dateFormat = "EEEE, MMM d"
    return f.string(from: date).uppercased()
}

// MARK: - Timeline

enum EntryState {
    case day(SnapshotDay, upcoming: [SnapshotDay]) // inside coverage
    case stale                                     // beyond the snapshot's endDate
    case noData                                    // no snapshot at all
}

struct DayEntry: TimelineEntry {
    let date: Date
    let state: EntryState
}

func entryState(for date: Date, snapshot: CalendarSnapshot?) -> EntryState {
    guard let snap = snapshot else { return .noData }
    let key = dayKey(date)
    if key > snap.endDate { return .stale }
    let today = snap.days.first(where: { $0.date == key })
        ?? SnapshotDay(date: key, allDay: [], timed: [])
    // Later covered days that actually hold something — the medium/large
    // layouts fill spare space with them, like Apple's widget.
    let upcoming = snap.days.filter { $0.date > key && (!$0.allDay.isEmpty || !$0.timed.isEmpty) }
    return .day(today, upcoming: upcoming)
}

let sampleDay = SnapshotDay(
    date: dayKey(Date()),
    allDay: [],
    timed: [
        SnapshotTimedRow(title: "Morning practice", color: "#388E3C", startMin: 9 * 60, endMin: 10 * 60, struck: nil),
        SnapshotTimedRow(title: "Dentist", color: "#1976D2", startMin: 13 * 60 + 30, endMin: 14 * 60 + 30, struck: nil),
        SnapshotTimedRow(title: "Dinner with friends", color: "#5E35B1", startMin: 18 * 60 + 30, endMin: 20 * 60, struck: nil),
    ])

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> DayEntry {
        DayEntry(date: Date(), state: .day(sampleDay, upcoming: []))
    }

    func getSnapshot(in context: Context, completion: @escaping (DayEntry) -> Void) {
        if context.isPreview {
            completion(DayEntry(date: Date(), state: .day(sampleDay, upcoming: [])))
            return
        }
        completion(DayEntry(date: Date(), state: entryState(for: Date(), snapshot: loadSnapshot())))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<DayEntry>) -> Void) {
        let now = Date()
        let cal = Calendar.current
        guard let snap = loadSnapshot() else {
            // Nothing to show until the app writes a snapshot (it pokes
            // WidgetKit when it does); re-check hourly as a backstop.
            completion(Timeline(
                entries: [DayEntry(date: now, state: .noData)],
                policy: .after(now.addingTimeInterval(3600))))
            return
        }

        var entries: [DayEntry] = []
        let todayKey = dayKey(now)

        // Today: one entry now, plus one at each remaining event end so
        // finished events drop off as the day progresses.
        entries.append(DayEntry(date: now, state: entryState(for: now, snapshot: snap)))
        if let today = snap.days.first(where: { $0.date == todayKey }) {
            let nowMin = minutesIntoDay(now)
            let ends = Set(today.timed.map { min($0.endMin, 24 * 60 - 1) }.filter { $0 > nowMin })
            for end in ends.sorted() {
                let at = instant(onDayOf: now, minutes: end)
                entries.append(DayEntry(date: at, state: entryState(for: at, snapshot: snap)))
            }
        }

        // Each upcoming local midnight through the coverage window rolls the
        // widget to that day — no app run required.
        for day in snap.days where day.date > todayKey {
            if let dayDate = dateFromKey(day.date) {
                entries.append(DayEntry(date: dayDate, state: entryState(for: dayDate, snapshot: snap)))
            }
        }

        // Past the last covered day, say so instead of showing a blank day.
        if let afterEnd = dateFromKey(snap.endDate).flatMap({ cal.date(byAdding: .day, value: 1, to: $0) }) {
            entries.append(DayEntry(date: afterEnd, state: .stale))
        }

        completion(Timeline(entries: entries.sorted { $0.date < $1.date }, policy: .atEnd))
    }
}

// MARK: - Bits

extension Color {
    init(hex: String) {
        var value: UInt64 = 0
        let cleaned = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        Scanner(string: cleaned).scanHexInt64(&value)
        self.init(
            .sRGB,
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255,
            opacity: 1)
    }
}

// Events still relevant at the entry's instant: everything all-day, plus timed
// events that haven't ended yet (the "what's left of my day" reading Apple's
// own calendar widget uses).
func remainingTimed(_ day: SnapshotDay, at date: Date) -> [SnapshotTimedRow] {
    dayKey(date) == day.date
        ? day.timed.filter { $0.endMin > minutesIntoDay(date) }
        : day.timed
}

// MARK: - Line-budget planner
// A chip is only emitted when it fully fits: a timed chip costs 2 lines; an
// all-day chip, a day eyebrow, and the "+N more" tail cost 1 each. Budgets are
// chosen for the smallest supported phone so the last chip never clips.

// Recomputed for the guaranteed 8pt top/bottom insets — one line fewer on the
// tight layouts so the bottom inset is always real, never eaten by content.
let smallLineBudget = 3
let mediumLeftLineBudget = 3
let mediumRightLineBudget = 6
let largeLineBudget = 12

struct PlanItem: Identifiable {
    enum Kind {
        case eyebrow(String)
        case allDay(SnapshotAllDayRow)
        case timed(SnapshotTimedRow, Date)
        case more(Int)
    }
    let id: Int
    let kind: Kind
}

func lineCost(_ kind: PlanItem.Kind) -> Int {
    if case .timed = kind { return 2 }
    return 1
}

func linesUsed(_ kinds: [PlanItem.Kind]) -> Int {
    kinds.reduce(0) { $0 + lineCost($1) }
}

func todayChipKinds(_ today: SnapshotDay, at date: Date) -> [PlanItem.Kind] {
    today.allDay.map { .allDay($0) } + remainingTimed(today, at: date).map { .timed($0, date) }
}

// Greedy prefix that fits the budget; the rest is returned untouched.
func fitGreedy(_ kinds: [PlanItem.Kind], budget: Int) -> (placed: [PlanItem.Kind], leftover: [PlanItem.Kind]) {
    var placed: [PlanItem.Kind] = []
    var used = 0
    var idx = 0
    while idx < kinds.count {
        let c = lineCost(kinds[idx])
        if used + c > budget { break }
        placed.append(kinds[idx])
        used += c
        idx += 1
    }
    return (placed, Array(kinds[idx...]))
}

// Greedy fit that ends in a "+N more" line whenever anything was dropped.
func fitWithMore(_ kinds: [PlanItem.Kind], budget: Int) -> [PlanItem.Kind] {
    var (placed, leftover) = fitGreedy(kinds, budget: budget)
    guard !leftover.isEmpty else { return placed }
    while !placed.isEmpty && linesUsed(placed) + 1 > budget {
        leftover.insert(placed.removeLast(), at: 0)
    }
    return placed + [.more(leftover.count)]
}

// Upcoming days, each an eyebrow + as many chips as still fit. A day whose
// chips don't all fit is cut short and ends the fill (no "+N more" here — the
// eyebrow already says there IS a next day).
func upcomingFill(_ upcoming: [SnapshotDay], budget: Int) -> [PlanItem.Kind] {
    var out: [PlanItem.Kind] = []
    var lines = budget
    for day in upcoming {
        guard lines >= 2, let d = dateFromKey(day.date) else { break }
        let chips: [PlanItem.Kind] = day.allDay.map { .allDay($0) } + day.timed.map { .timed($0, d) }
        let (placed, leftover) = fitGreedy(chips, budget: lines - 1)
        if placed.isEmpty { break }
        out.append(.eyebrow(upcomingHeader(for: d)))
        out += placed
        lines -= 1 + linesUsed(placed)
        if !leftover.isEmpty { break }
    }
    return out
}

// MARK: - Views

struct DateHeader: View {
    let date: Date

    var body: some View {
        // Sized to match Apple's Calendar widget header exactly — largeTitle
        // read slightly bigger on device and stole a chip row from the small
        // family.
        VStack(alignment: .leading, spacing: 0) {
            Text(date, format: .dateTime.weekday(.wide))
                .font(.caption2)
                .fontWeight(.semibold)
                .textCase(.uppercase)
                .foregroundStyle(Color.accentColor)
            Text(date, format: .dateTime.day())
                .font(.system(size: 26, weight: .medium))
        }
        // The header's size and position are fixed facts of the layout — the
        // chip area below is what flexes and clips, never this.
        .fixedSize()
        .layoutPriority(1)
    }
}

// Apple-style timed-event chip: colour-tinted rounded rect, colour bar at the
// left, title + compact range in the calendar colour. Two lines.
struct TimedChip: View {
    let row: SnapshotTimedRow
    let day: Date // the day this chip belongs to (times are minutes into it)
    var compact = false

    var body: some View {
        let color = Color(hex: row.color)
        let struck = row.struck == true
        HStack(alignment: .center, spacing: 6) {
            RoundedRectangle(cornerRadius: 1.5)
                .fill(color)
                .frame(width: 3)
                .padding(.vertical, 1)
            VStack(alignment: .leading, spacing: 0) {
                Text(row.title)
                    .font(compact ? .caption2 : .caption)
                    .fontWeight(.semibold)
                    .strikethrough(struck)
                    .lineLimit(1)
                Text(timeRangeLabel(onDayOf: day, startMin: row.startMin, endMin: row.endMin))
                    .font(.caption2)
                    .opacity(0.8)
                    .lineLimit(1)
            }
            .foregroundStyle(color)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .padding(.leading, 4)
        .padding(.trailing, 6)
        .background(color.opacity(0.17), in: RoundedRectangle(cornerRadius: 7))
        .opacity(struck ? 0.55 : 1)
        .fixedSize(horizontal: false, vertical: true)
    }
}

// All-day items wear the SAME tinted-chip dress as timed events, on ONE line:
// title leading, the item's kind trailing ("All day", "Chore", "Holiday", …).
func allDayKindLabel(_ kind: String) -> String {
    switch kind {
    case "trip": return "Trip"
    case "holiday": return "Holiday"
    case "occasion": return "Occasion"
    case "task": return "Task"
    case "chore": return "Chore"
    case "recipe": return "Meal"
    case "grocery": return "Grocery"
    default: return "All day"
    }
}

struct AllDayChip: View {
    let row: SnapshotAllDayRow
    var compact = false

    var body: some View {
        let color = Color(hex: row.color)
        let struck = row.struck == true
        HStack(alignment: .center, spacing: 6) {
            RoundedRectangle(cornerRadius: 1.5)
                .fill(color)
                .frame(width: 3)
                .padding(.vertical, 1)
            Text(row.title)
                .font(compact ? .caption2 : .caption)
                .fontWeight(.semibold)
                .strikethrough(struck)
                .lineLimit(1)
            Spacer(minLength: 4)
            Text(allDayKindLabel(row.kind))
                .font(.caption2)
                .opacity(0.7)
                .lineLimit(1)
        }
        .foregroundStyle(color)
        .padding(.vertical, 3)
        .padding(.leading, 4)
        .padding(.trailing, 6)
        .background(color.opacity(0.17), in: RoundedRectangle(cornerRadius: 7))
        .opacity(struck ? 0.55 : 1)
        .fixedSize(horizontal: false, vertical: true)
    }
}

struct DayEyebrow: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption2)
            .fontWeight(.semibold)
            .foregroundStyle(.secondary)
            .lineLimit(1)
    }
}

struct MessageView: View {
    let icon: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(text)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}

struct TodayWidgetView: View {
    var entry: DayEntry
    @Environment(\.widgetFamily) var family

    var body: some View {
        content
            // One uniform vertical inset for every family and state — the
            // side margins come from the system and are right as-is; the
            // vertical breathing room is ours, applied ONCE here, never
            // per-layout (per-layout paddings drifted apart on device).
            .padding(.top, 8)
            .padding(.bottom, 8)
            .containerBackground(for: .widget) { Color(UIColor.systemBackground) }
            .widgetURL(URL(string: "householdcalendar://calendar/day/\(dayKey(entry.date))"))
    }

    @ViewBuilder
    var content: some View {
        switch entry.state {
        case .noData:
            statusBody(icon: "calendar", text: "Open Calen to see your day here")
        case .stale:
            statusBody(icon: "arrow.triangle.2.circlepath", text: "Open Calen to update")
        case .day(let today, let upcoming):
            switch family {
            case .systemMedium: mediumView(today, upcoming)
            case .systemLarge: largeView(today, upcoming)
            default: smallView(today)
            }
        }
    }

    func statusBody(icon: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            DateHeader(date: entry.date)
            Spacer()
            MessageView(icon: icon, text: text)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // "Nothing (left) today" line for a day inside coverage.
    func emptyToday(_ today: SnapshotDay) -> some View {
        Text(today.timed.isEmpty && today.allDay.isEmpty ? "No events today" : "No more events today")
            .font(.caption2)
            .foregroundStyle(.secondary)
    }

    func chipColumn(_ kinds: [PlanItem.Kind], compact: Bool) -> some View {
        let items = kinds.enumerated().map { PlanItem(id: $0.offset, kind: $0.element) }
        return VStack(alignment: .leading, spacing: 4) {
            ForEach(items) { item in
                switch item.kind {
                case .eyebrow(let text):
                    DayEyebrow(text: text).padding(.top, 2)
                case .allDay(let row):
                    AllDayChip(row: row, compact: compact)
                case .timed(let row, let day):
                    TimedChip(row: row, day: day, compact: compact)
                case .more(let n):
                    Text("+\(n) more")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // Header first (immovable), then the planned chips; `.clipped()` is a
    // safety net — the planner should never overrun the budgeted space.
    func headerAndChips<C: View>(_ chips: C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            DateHeader(date: entry.date)
            chips
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .clipped()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    func smallView(_ today: SnapshotDay) -> some View {
        let kinds = todayChipKinds(today, at: entry.date)
        return headerAndChips(
            Group {
                if kinds.isEmpty {
                    emptyToday(today)
                } else {
                    chipColumn(fitWithMore(kinds, budget: smallLineBudget), compact: true)
                }
            }
        )
    }

    // Left half: date + today. Right half: today's OVERFLOW first (today
    // outranks the future, like Apple's widget), then upcoming days.
    func mediumView(_ today: SnapshotDay, _ upcoming: [SnapshotDay]) -> some View {
        let kinds = todayChipKinds(today, at: entry.date)
        let (leftPlaced, leftover) = fitGreedy(kinds, budget: mediumLeftLineBudget)
        let rightKinds: [PlanItem.Kind]
        if leftover.isEmpty {
            rightKinds = upcomingFill(upcoming, budget: mediumRightLineBudget)
        } else {
            let (spill, stillOver) = fitGreedy(leftover, budget: mediumRightLineBudget)
            if stillOver.isEmpty {
                let remaining = mediumRightLineBudget - linesUsed(spill)
                rightKinds = spill + upcomingFill(upcoming, budget: remaining)
            } else {
                rightKinds = fitWithMore(leftover, budget: mediumRightLineBudget)
            }
        }

        return HStack(alignment: .top, spacing: 12) {
            headerAndChips(
                Group {
                    if kinds.isEmpty {
                        emptyToday(today)
                    } else {
                        chipColumn(leftPlaced, compact: true)
                    }
                }
            )
            chipColumn(rightKinds, compact: true)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .clipped()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // One column: today first (with a "+N more" tail when it overflows the
    // whole budget), upcoming days only in the space today leaves behind.
    func largeView(_ today: SnapshotDay, _ upcoming: [SnapshotDay]) -> some View {
        let kinds = todayChipKinds(today, at: entry.date)
        let (placedToday, leftoverToday) = fitGreedy(kinds, budget: largeLineBudget)
        let items: [PlanItem.Kind] = leftoverToday.isEmpty
            ? placedToday + upcomingFill(upcoming, budget: largeLineBudget - linesUsed(placedToday))
            : fitWithMore(kinds, budget: largeLineBudget)

        return headerAndChips(
            Group {
                if kinds.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        emptyToday(today)
                        chipColumn(upcomingFill(upcoming, budget: largeLineBudget - 1), compact: false)
                    }
                } else {
                    chipColumn(items, compact: false)
                }
            }
        )
    }
}

// MARK: - Widget declaration

struct CalenTodayWidget: Widget {
    let kind: String = "CalenToday"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: Provider()) { entry in
            TodayWidgetView(entry: entry)
        }
        .configurationDisplayName("Today")
        .description("See today's events from your household calendar.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

@main
struct CalenWidgetBundle: WidgetBundle {
    var body: some Widget {
        CalenTodayWidget()
    }
}
