// Jarvis Apple helper: read-only access to Apple Calendar and Reminders via
// EventKit. The Node server runs it and passes the calendar / list IDs it may
// read (only those in accounts the user approved); it never writes anything.
//
//   jarvis-apple sources
//   jarvis-apple events <fromISO> <toISO> <calendarId,...>
//   jarvis-apple reminders <listId,...>
//
// Prints one JSON object to stdout. Errors: {"error": "..."} and exit 1.
import EventKit
import Foundation

let store = EKEventStore()
let iso = ISO8601DateFormatter()

func emit(_ obj: Any) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    exit(0)
}
func fail(_ message: String) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: ["error": message])
    FileHandle.standardOutput.write(data)
    exit(1)
}

func sourceType(_ s: EKSource) -> String {
    switch s.sourceType {
    case .local: return "local"
    case .exchange: return "exchange"
    case .calDAV: return "caldav"
    case .mobileMe: return "icloud"
    case .subscribed: return "subscribed"
    case .birthdays: return "birthdays"
    @unknown default: return "other"
    }
}

func calendarInfo(_ c: EKCalendar, kind: String) -> [String: Any] {
    ["id": c.calendarIdentifier, "title": c.title, "kind": kind,
     "account": c.source?.title ?? "", "accountType": c.source.map(sourceType) ?? "other"]
}

func access(_ type: EKEntityType) async -> Bool {
    do {
        return type == .event ? try await store.requestFullAccessToEvents() : try await store.requestFullAccessToReminders()
    } catch {
        return false
    }
}

func ids(_ arg: String) -> Set<String> { Set(arg.split(separator: ",").map(String.init)) }

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: jarvis-apple sources | events <from> <to> <ids> | reminders <ids>") }

switch args[1] {
case "sources":
    let ev = await access(.event)
    let rem = await access(.reminder)
    var cals: [[String: Any]] = []
    if ev { cals += store.calendars(for: .event).map { calendarInfo($0, kind: "calendar") } }
    if rem { cals += store.calendars(for: .reminder).map { calendarInfo($0, kind: "reminders") } }
    emit(["access": ["calendar": ev, "reminders": rem], "calendars": cals])

case "events":
    guard args.count == 5, let from = iso.date(from: args[2]), let to = iso.date(from: args[3]) else { fail("events needs <fromISO> <toISO> <ids>") }
    guard await access(.event) else { fail("Calendar access not granted") }
    let wanted = ids(args[4])
    let cals = store.calendars(for: .event).filter { wanted.contains($0.calendarIdentifier) }
    if cals.isEmpty { emit(["events": []]) }
    let found = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: cals))
    let events: [[String: Any]] = found.map { e in
        var o: [String: Any] = [
            "id": e.eventIdentifier ?? "", "title": e.title ?? "Untitled", "allDay": e.isAllDay,
            "start": iso.string(from: e.startDate), "end": iso.string(from: e.endDate),
            "calendar": e.calendar.title, "account": e.calendar.source?.title ?? "",
            "location": e.location ?? "", "notes": e.notes ?? "",
            "status": e.status == .canceled ? "cancelled" : "confirmed",
        ]
        if let url = e.url?.absoluteString { o["url"] = url }
        o["attendees"] = (e.attendees ?? []).map { a in
            ["name": a.name ?? "", "self": a.isCurrentUser,
             "status": [EKParticipantStatus.accepted: "accepted", .declined: "declined", .tentative: "tentative"][a.participantStatus] ?? "needsAction"] as [String: Any]
        }
        return o
    }
    emit(["events": events])

case "reminders":
    guard args.count == 3 else { fail("reminders needs <ids>") }
    guard await access(.reminder) else { fail("Reminders access not granted") }
    let wanted = ids(args[2])
    let lists = store.calendars(for: .reminder).filter { wanted.contains($0.calendarIdentifier) }
    if lists.isEmpty { emit(["reminders": []]) }
    let found: [EKReminder] = await withCheckedContinuation { cont in
        store.fetchReminders(matching: store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: lists)) { cont.resume(returning: $0 ?? []) }
    }
    let reminders: [[String: Any]] = found.map { r in
        var o: [String: Any] = ["id": r.calendarItemIdentifier, "title": r.title ?? "", "list": r.calendar.title,
                                "account": r.calendar.source?.title ?? "", "priority": r.priority, "notes": r.notes ?? ""]
        if let comps = r.dueDateComponents, let d = Calendar.current.date(from: comps) {
            o["due"] = iso.string(from: d)
            o["dueHasTime"] = comps.hour != nil
        }
        return o
    }
    emit(["reminders": reminders])

default:
    fail("unknown command \(args[1])")
}
