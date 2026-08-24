//! Minimal RRULE support (subset of RFC 5545): daily/weekly/monthly/yearly with
//! an optional interval, `BYDAY` for weekly rules and `COUNT`/`UNTIL` as the stop
//! condition. Series are expanded on demand for a requested window, so infinite
//! recurrences never have to be materialised in the database.

use chrono::{DateTime, Datelike, Duration, Months, TimeZone, Timelike, Utc, Weekday};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Frequency {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Debug, Clone)]
pub struct ParsedRule {
    pub frequency: Frequency,
    pub interval: u32,
    pub count: Option<u32>,
    pub until: Option<DateTime<Utc>>,
    /// Weekday numbers, Sunday = 0.
    pub by_day: Option<Vec<u32>>,
}

fn weekday_index(code: &str) -> Option<u32> {
    match code {
        "SU" => Some(0),
        "MO" => Some(1),
        "TU" => Some(2),
        "WE" => Some(3),
        "TH" => Some(4),
        "FR" => Some(5),
        "SA" => Some(6),
        _ => None,
    }
}

fn parse_ics_date(value: &str) -> Option<DateTime<Utc>> {
    let value = value.trim();
    let digits: String = value.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() >= 8 {
        let year: i32 = digits[0..4].parse().ok()?;
        let month: u32 = digits[4..6].parse().ok()?;
        let day: u32 = digits[6..8].parse().ok()?;
        let (hour, minute, second) = if digits.len() >= 14 {
            (
                digits[8..10].parse().ok()?,
                digits[10..12].parse().ok()?,
                digits[12..14].parse().ok()?,
            )
        } else {
            (0, 0, 0)
        };
        return Utc
            .with_ymd_and_hms(year, month, day, hour, minute, second)
            .single();
    }
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

pub fn parse_rrule(rrule: Option<&str>) -> Option<ParsedRule> {
    let rrule = rrule?.trim();
    if rrule.is_empty() {
        return None;
    }
    let mut frequency = None;
    let mut interval = 1u32;
    let mut count = None;
    let mut until = None;
    let mut by_day = None;

    for part in rrule.trim_start_matches("RRULE:").split(';') {
        let Some((key, value)) = part.split_once('=') else {
            continue;
        };
        match key.trim().to_ascii_uppercase().as_str() {
            "FREQ" => {
                frequency = match value.trim().to_ascii_uppercase().as_str() {
                    "DAILY" => Some(Frequency::Daily),
                    "WEEKLY" => Some(Frequency::Weekly),
                    "MONTHLY" => Some(Frequency::Monthly),
                    "YEARLY" => Some(Frequency::Yearly),
                    _ => None,
                }
            }
            "INTERVAL" => interval = value.trim().parse().unwrap_or(1).max(1),
            "COUNT" => count = value.trim().parse().ok(),
            "UNTIL" => until = parse_ics_date(value),
            "BYDAY" => {
                let days: Vec<u32> = value
                    .split(',')
                    .filter_map(|code| {
                        let code = code.trim().to_ascii_uppercase();
                        weekday_index(&code[code.len().saturating_sub(2)..])
                    })
                    .collect();
                if !days.is_empty() {
                    by_day = Some(days);
                }
            }
            _ => {}
        }
    }

    Some(ParsedRule {
        frequency: frequency?,
        interval,
        count,
        until,
        by_day,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Occurrence {
    pub index: u32,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
}

const MAX_STEPS: u32 = 500;

fn advance(base: DateTime<Utc>, rule: &ParsedRule, steps: u32) -> Option<DateTime<Utc>> {
    let factor = rule.interval * steps;
    match rule.frequency {
        Frequency::Daily => base.checked_add_signed(Duration::days(factor as i64)),
        Frequency::Weekly => base.checked_add_signed(Duration::weeks(factor as i64)),
        Frequency::Monthly => base.checked_add_months(Months::new(factor)),
        Frequency::Yearly => base.checked_add_months(Months::new(factor * 12)),
    }
}

/// Materialises every occurrence overlapping `[window_start, window_end]`.
pub fn expand_occurrences(
    starts_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
    rrule: Option<&str>,
    window_start: DateTime<Utc>,
    window_end: DateTime<Utc>,
) -> Vec<Occurrence> {
    let duration = (ends_at - starts_at).max(Duration::zero());
    let Some(rule) = parse_rrule(rrule) else {
        return if starts_at <= window_end && ends_at >= window_start {
            vec![Occurrence {
                index: 0,
                starts_at,
                ends_at,
            }]
        } else {
            Vec::new()
        };
    };

    let weekly_days = match (rule.frequency, rule.by_day.as_ref()) {
        (Frequency::Weekly, Some(days)) if !days.is_empty() => {
            let mut days = days.clone();
            days.sort_unstable();
            Some(days)
        }
        _ => None,
    };

    let mut result = Vec::new();
    let mut emitted = 0u32;

    for step in 0..MAX_STEPS {
        let Some(base) = advance(starts_at, &rule, step) else {
            break;
        };
        if base > window_end && emitted > 0 {
            break;
        }
        if rule.until.is_some_and(|until| base > until) {
            break;
        }

        let candidates: Vec<DateTime<Utc>> = match &weekly_days {
            Some(days) => {
                // Anchor to the Sunday of that week, then pick the BYDAY offsets.
                let offset = base.weekday().num_days_from_sunday() as i64;
                let week_start = base - Duration::days(offset);
                days.iter()
                    .filter_map(|day| {
                        let candidate = week_start + Duration::days(*day as i64);
                        candidate
                            .with_hour(starts_at.hour())?
                            .with_minute(starts_at.minute())?
                            .with_second(starts_at.second())?
                            .with_nanosecond(0)
                    })
                    .filter(|candidate| *candidate >= starts_at)
                    .collect()
            }
            None => vec![base],
        };

        for candidate in candidates {
            if rule.count.is_some_and(|count| emitted >= count) {
                return result;
            }
            if rule.until.is_some_and(|until| candidate > until) {
                return result;
            }
            emitted += 1;
            let occurrence_end = candidate + duration;
            if candidate <= window_end && occurrence_end >= window_start {
                result.push(Occurrence {
                    index: emitted - 1,
                    starts_at: candidate,
                    ends_at: occurrence_end,
                });
            }
        }

        if rule.count.is_some_and(|count| emitted >= count) {
            break;
        }
        if base > window_end {
            break;
        }
    }
    result
}

/// Human readable summary, e.g. "jede Woche, 4×".
pub fn describe_rrule(rrule: Option<&str>) -> Option<String> {
    let rule = parse_rrule(rrule)?;
    let base = if rule.interval > 1 {
        let unit = match rule.frequency {
            Frequency::Daily => "Tage",
            Frequency::Weekly => "Wochen",
            Frequency::Monthly => "Monate",
            Frequency::Yearly => "Jahre",
        };
        format!("alle {} {unit}", rule.interval)
    } else {
        match rule.frequency {
            Frequency::Daily => "jeden Tag".to_string(),
            Frequency::Weekly => "jede Woche".to_string(),
            Frequency::Monthly => "jeden Monat".to_string(),
            Frequency::Yearly => "jedes Jahr".to_string(),
        }
    };
    Some(match (rule.count, rule.until) {
        (Some(count), _) => format!("{base}, {count}×"),
        (None, Some(until)) => format!("{base} bis {}", until.format("%d.%m.%Y")),
        _ => base,
    })
}

/// Sunday-based weekday index, mirroring the ICS BYDAY numbering.
pub fn weekday_number(weekday: Weekday) -> u32 {
    weekday.num_days_from_sunday()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(year: i32, month: u32, day: u32, hour: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(year, month, day, hour, 0, 0).unwrap()
    }

    #[test]
    fn returns_a_single_event_without_a_rule() {
        let start = at(2026, 8, 24, 10);
        let occurrences = expand_occurrences(
            start,
            start + Duration::hours(1),
            None,
            at(2026, 8, 1, 0),
            at(2026, 9, 1, 0),
        );
        assert_eq!(occurrences.len(), 1);
        assert_eq!(occurrences[0].starts_at, start);
    }

    #[test]
    fn honours_count() {
        let start = at(2026, 8, 24, 10);
        let occurrences = expand_occurrences(
            start,
            start + Duration::hours(1),
            Some("FREQ=WEEKLY;INTERVAL=1;COUNT=4"),
            at(2026, 8, 1, 0),
            at(2027, 1, 1, 0),
        );
        assert_eq!(occurrences.len(), 4);
        assert_eq!(occurrences[3].starts_at, start + Duration::weeks(3));
    }

    #[test]
    fn honours_until() {
        let start = at(2026, 8, 24, 10);
        let occurrences = expand_occurrences(
            start,
            start + Duration::hours(1),
            Some("FREQ=DAILY;UNTIL=20260827T000000Z"),
            at(2026, 8, 1, 0),
            at(2026, 9, 1, 0),
        );
        assert_eq!(occurrences.len(), 3);
    }

    #[test]
    fn expands_weekly_by_day() {
        // Monday 2026-08-24; ask for Monday and Wednesday.
        let start = at(2026, 8, 24, 9);
        let occurrences = expand_occurrences(
            start,
            start + Duration::hours(1),
            Some("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4"),
            at(2026, 8, 1, 0),
            at(2026, 10, 1, 0),
        );
        assert_eq!(occurrences.len(), 4);
        assert_eq!(occurrences[0].starts_at.weekday(), Weekday::Mon);
        assert_eq!(occurrences[1].starts_at.weekday(), Weekday::Wed);
        assert_eq!(occurrences[2].starts_at, start + Duration::weeks(1));
    }

    #[test]
    fn clips_to_the_requested_window() {
        let start = at(2026, 1, 1, 8);
        let occurrences = expand_occurrences(
            start,
            start + Duration::hours(1),
            Some("FREQ=MONTHLY;COUNT=12"),
            at(2026, 6, 1, 0),
            at(2026, 8, 1, 0),
        );
        assert_eq!(occurrences.len(), 2);
        assert_eq!(occurrences[0].starts_at.month(), 6);
    }

    #[test]
    fn describes_rules_in_german() {
        assert_eq!(
            describe_rrule(Some("FREQ=WEEKLY;COUNT=4")).unwrap(),
            "jede Woche, 4×"
        );
        assert_eq!(
            describe_rrule(Some("FREQ=DAILY;INTERVAL=3")).unwrap(),
            "alle 3 Tage"
        );
        assert!(describe_rrule(None).is_none());
    }
}
