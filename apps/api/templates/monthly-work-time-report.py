from datetime import datetime
from zoneinfo import ZoneInfo


def to_local(value, timezone):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(ZoneInfo(timezone))


def time_value(minutes):
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def run(context):
    timezones = {item["id"]: item.get("timezone", "Europe/Vienna") for item in context.get("locations", [])}
    records = {day: {"d": str(day), "s": "00:00", "e": "00:00", "ps": "00:00", "pe": "00:00", "h": "00:00", "n": "", "minutes": 0, "notes": []} for day in range(1, 32)}

    for entry in context["report_rows"]:
        timezone = timezones.get(entry["location_id"], "Europe/Vienna")
        start = to_local(entry["arrived_at"], timezone)
        end = to_local(entry["left_at"], timezone)
        row = records[start.day]
        start_text, end_text = start.strftime("%H:%M"), end.strftime("%H:%M")
        if row["s"] == "00:00" or start_text < row["s"]:
            row["s"] = start_text
        if row["e"] == "00:00" or end_text > row["e"]:
            row["e"] = end_text
        row["minutes"] += round(float(entry["hours"]) * 60)
        note = entry.get("booking_customer") or entry.get("booking_product") or ""
        if note and note not in row["notes"]:
            row["notes"].append(note)

    result = {}
    for day, row in records.items():
        row["h"] = time_value(row.pop("minutes"))
        row["n"] = ", ".join(row.pop("notes"))
        result[f"r{day:02d}"] = row
    return result
