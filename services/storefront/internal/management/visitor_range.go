package management

import (
	"math"
	"net/url"
	"regexp"
	"strconv"
	"time"

	"gptibo/storefront/internal/fault"
)

type VisitorRange struct {
	Start, End   string
	Since, Until int64
	Days         int
}

var visitorZone = time.FixedZone("CST", 8*3600)
var automatedAgent = regexp.MustCompile(`(?i)bot\b|spider|crawler|headless|playwright|puppeteer|selenium|phantomjs|lighthouse|curl/|wget/|python-requests|go-http-client`)

func AutomatedVisitor(agent string) bool { return automatedAgent.MatchString(agent) }
func ParseVisitorRange(q url.Values, now time.Time) (VisitorRange, error) {
	bad := func() (VisitorRange, error) {
		return VisitorRange{}, fault.New(400, "日期范围须为不超过今天的连续 1 至 366 天。")
	}
	start, end := q.Get("start"), q.Get("end")
	today := now.In(visitorZone)
	if q.Has("start") || q.Has("end") {
		if q.Has("days") || q.Has("period") {
			return bad()
		}
	} else if q.Has("period") {
		if q.Has("days") {
			return bad()
		}
		switch q.Get("period") {
		case "today":
			start = chinaDay(today)
		case "yesterday":
			start = chinaDay(today.AddDate(0, 0, -1))
		default:
			return bad()
		}
		end = start
	} else {
		value := q.Get("days")
		if !q.Has("days") {
			value = "7"
		}
		if value != "7" && value != "30" && value != "90" {
			return bad()
		}
		days, _ := strconv.Atoi(value)
		start = chinaDay(today.AddDate(0, 0, -days+1))
		end = chinaDay(today)
	}
	a, e := time.ParseInLocation("2006-01-02", start, visitorZone)
	if e != nil || a.Format("2006-01-02") != start {
		return bad()
	}
	b, e := time.ParseInLocation("2006-01-02", end, visitorZone)
	if e != nil || b.Format("2006-01-02") != end {
		return bad()
	}
	until := b.AddDate(0, 0, 1)
	days := int(until.Sub(a).Hours() / 24)
	if days < 1 || days > 366 || end > chinaDay(now) {
		return bad()
	}
	return VisitorRange{start, end, a.UnixMilli(), until.UnixMilli(), days}, nil
}
func visitorPercent(part, total int64) float64 {
	if total == 0 {
		return 0
	}
	return math.Round(float64(part)/float64(total)*1000) / 10
}
