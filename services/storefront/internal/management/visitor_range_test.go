package management

import (
	"net/url"
	"testing"
	"time"
)

func TestVisitorCalendarRanges(t *testing.T) {
	now, _ := time.Parse(time.RFC3339, "2026-03-01T00:10:00+08:00")
	for _, tc := range []struct {
		query, start, end string
		days              int
	}{
		{"period=today", "2026-03-01", "2026-03-01", 1},
		{"period=yesterday", "2026-02-28", "2026-02-28", 1},
		{"days=7", "2026-02-23", "2026-03-01", 7},
		{"days=30", "2026-01-31", "2026-03-01", 30},
		{"days=90", "2025-12-02", "2026-03-01", 90},
		{"start=2024-02-29&end=2024-03-01", "2024-02-29", "2024-03-01", 2},
	} {
		q, _ := url.ParseQuery(tc.query)
		r, e := ParseVisitorRange(q, now)
		if e != nil || r.Start != tc.start || r.End != tc.end || r.Days != tc.days || r.Until-r.Since != int64(tc.days)*86400000 {
			t.Fatalf("%s: %+v %v", tc.query, r, e)
		}
		if chinaDay(time.UnixMilli(r.Since)) != tc.start || chinaDay(time.UnixMilli(r.Until-1)) != tc.end {
			t.Fatal("incorrect exclusive Beijing boundary", r)
		}
	}
	for _, query := range []string{"days=1", "days=", "period=custom", "start=2026-02-29&end=2026-03-01", "start=2026-03-01", "start=2026-03-02&end=2026-03-01", "start=2025-01-01&end=2026-03-01", "start=2026-03-01&end=2026-03-02", "days=7&period=today", "start=2026-03-01&end=2026-03-01&days=7"} {
		q, _ := url.ParseQuery(query)
		if _, e := ParseVisitorRange(q, now); e == nil {
			t.Fatal("invalid range accepted", query)
		}
	}
	if visitorPercent(1, 3) != 33.3 || visitorPercent(1, 0) != 0 {
		t.Fatal("invalid percentage")
	}
	if AutomatedVisitor("Mozilla/5.0 Chrome/140 Safari/537.36") {
		t.Fatal("ordinary browser excluded")
	}
	for _, ua := range []string{"Googlebot/2.1", "HeadlessChrome/140", "curl/8", "Go-http-client/1.1", "Playwright"} {
		if !AutomatedVisitor(ua) {
			t.Fatal("robot accepted", ua)
		}
	}
}
