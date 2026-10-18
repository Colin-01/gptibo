package management

import (
	"context"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"gptibo/storefront/internal/auth"
	"gptibo/storefront/internal/fault"
	"gptibo/storefront/internal/security"
)

var publicPath = regexp.MustCompile(`^/(?:orders|product/[a-z0-9-]+)?$`)
var shopPath = regexp.MustCompile(`^/(?:r|s)/([^/]+)(?:/(?:orders|product/[a-z0-9-]+))?$`)

type VisitorInput struct {
	VisitorID string `json:"visitorId"`
	Path      string `json:"path"`
	Event     string `json:"event"`
	Automated bool   `json:"automated"`
}

func chinaDay(t time.Time) string { return t.In(time.FixedZone("CST", 8*3600)).Format("2006-01-02") }
func (s Service) RecordVisitor(ctx context.Context, in VisitorInput) error {
	if in.Event == "" {
		in.Event = "pageview"
	}
	if in.Event != "pageview" && in.Event != "checkout" && in.Event != "payment" {
		return fault.New(400, "统计事件无效。")
	}
	if in.Automated {
		return nil
	}
	if !security.ValidID(in.VisitorID) || in.Path == "" || len(in.Path) > 120 {
		return fault.New(400, "访客标识或页面路径无效。")
	}
	path := strings.TrimSuffix(in.Path, "/")
	if path == "" {
		path = "/"
	}
	owner := "platform"
	if match := shopPath.FindStringSubmatch(path); match != nil {
		if e := s.Store.DB.QueryRow(ctx, `SELECT s.id FROM partner_stores s JOIN partners p ON p.id=s.partner_id WHERE s.slug=$1 AND s.active AND p.active`, match[1]).Scan(&owner); e != nil {
			if e == pgx.ErrNoRows {
				return fault.New(404, "代理商店不可用。")
			}
			return e
		}
	} else if !publicPath.MatchString(path) {
		return fault.New(400, "页面路径无效。")
	}
	page, product, checkout, payment := 0, 0, 0, 0
	if in.Event == "pageview" {
		page = 1
		if strings.Contains(path, "/product/") {
			product = 1
		}
	}
	if in.Event == "checkout" {
		checkout = 1
	}
	if in.Event == "payment" {
		payment = 1
	}
	_, e := s.Store.DB.Exec(ctx, `INSERT INTO visitor_days(day,shop_id,visitor_hash,page_views,product_view,checkout_view,payment_view) VALUES($1,$2,$3,$4,$5,$6,$7)
 ON CONFLICT(day,shop_id,visitor_hash) DO UPDATE SET page_views=visitor_days.page_views+excluded.page_views,
 product_view=GREATEST(visitor_days.product_view,excluded.product_view),checkout_view=GREATEST(visitor_days.checkout_view,excluded.checkout_view),payment_view=GREATEST(visitor_days.payment_view,excluded.payment_view)`, chinaDay(time.Now()), owner, security.Hash(in.VisitorID), page, product, checkout, payment)
	return e
}
func (s Service) Visitors(ctx context.Context, days int, shop string, admin bool) (map[string]any, error) {
	r, e := ParseVisitorRange(url.Values{"days": {strconv.Itoa(days)}}, time.Now())
	if e != nil {
		return nil, e
	}
	return s.VisitorsRange(ctx, r, shop, admin)
}
func (s Service) VisitorsRange(ctx context.Context, r VisitorRange, shop string, admin bool) (map[string]any, error) {
	tx, e := s.Store.DB.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	list, e := rows(ctx, tx, `SELECT day,sum(page_views)::bigint "pageViews",count(DISTINCT visitor_hash) FILTER(WHERE page_views>0) visitors FROM visitor_days WHERE day BETWEEN $1 AND $3 AND ($2='' OR shop_id=$2 OR shop_id IN (SELECT id FROM partner_stores WHERE partner_id=$2)) GROUP BY day ORDER BY day`, r.Start, shop, r.End)
	if e != nil {
		return nil, e
	}
	total, e := rows(ctx, tx, `WITH people AS (
 SELECT visitor_hash,sum(page_views) views,max(product_view) product,max(checkout_view) checkout,max(payment_view) payment
 FROM visitor_days WHERE day BETWEEN $1 AND $3 AND ($2='' OR shop_id=$2 OR shop_id IN (SELECT id FROM partner_stores WHERE partner_id=$2)) GROUP BY visitor_hash)
 SELECT COALESCE(sum(views),0)::bigint "pageViews",count(*) FILTER(WHERE views>0) visitors,
 count(*) FILTER(WHERE views>=2 OR product=1) "effectiveVisitors",count(*) FILTER(WHERE views=1) "bouncedVisitors",
 COALESCE(sum(product),0)::bigint "productVisitors",COALESCE(sum(checkout),0)::bigint "checkoutVisitors",COALESCE(sum(payment),0)::bigint "paymentVisitors" FROM people`, r.Start, shop, r.End)
	if e != nil {
		return nil, e
	}
	byDay := map[string]map[string]any{}
	for _, r := range list {
		byDay[r["day"].(string)] = r
	}
	trend := []map[string]any{}
	for i := 0; i < r.Days; i++ {
		day := chinaDay(time.UnixMilli(r.Since).AddDate(0, 0, i))
		r := byDay[day]
		if r == nil {
			r = map[string]any{"day": day, "pageViews": int64(0), "visitors": int64(0)}
		}
		trend = append(trend, r)
	}
	out := total[0]
	out["days"] = r.Days
	out["start"] = r.Start
	out["end"] = r.End
	out["trend"] = trend
	today, e := rows(ctx, tx, `SELECT COALESCE(sum(page_views),0)::bigint "pageViews",count(DISTINCT visitor_hash) FILTER(WHERE page_views>0) visitors FROM visitor_days WHERE day=$1 AND ($2='' OR shop_id=$2 OR shop_id IN (SELECT id FROM partner_stores WHERE partner_id=$2))`, chinaDay(time.Now()), shop)
	if e != nil {
		return nil, e
	}
	out["today"] = today[0]
	paid, e := rows(ctx, tx, `SELECT count(DISTINCT o.id) paid FROM order_events e JOIN orders o ON o.id=e.order_id
 WHERE e.action='payment-confirmed' AND e.created_at>=$1 AND e.created_at<$2 AND o.mode='live' AND o.is_test=0 AND o.payment_status='paid'
 AND NOT EXISTS(SELECT 1 FROM order_events earlier WHERE earlier.order_id=e.order_id AND earlier.action='payment-confirmed' AND earlier.created_at<e.created_at)
 AND ($3='' OR o.partner_id=$3 OR o.store_id=$3 OR ($3='platform' AND o.partner_id IS NULL))`, r.Since, r.Until, shop)
	if e != nil {
		return nil, e
	}
	visitors := out["visitors"].(int64)
	paidOrders := paid[0]["paid"].(int64)
	out["effectiveRate"] = visitorPercent(out["effectiveVisitors"].(int64), visitors)
	out["bounceRate"] = visitorPercent(out["bouncedVisitors"].(int64), visitors)
	out["conversionRate"] = visitorPercent(paidOrders, visitors)
	out["funnel"] = map[string]any{"visitors": visitors, "productVisitors": out["productVisitors"], "checkoutVisitors": out["checkoutVisitors"], "paymentVisitors": out["paymentVisitors"], "paidOrders": paidOrders}
	delete(out, "bouncedVisitors")
	delete(out, "productVisitors")
	delete(out, "checkoutVisitors")
	delete(out, "paymentVisitors")
	if admin {
		platform, e := rows(ctx, tx, `SELECT COALESCE(sum(page_views),0)::bigint "pageViews",count(DISTINCT visitor_hash) FILTER(WHERE page_views>0) visitors FROM visitor_days WHERE day BETWEEN $1 AND $2 AND shop_id='platform'`, r.Start, r.End)
		if e != nil {
			return nil, e
		}
		out["platform"] = platform[0]
		// Aggregate traffic once before joining partner details. A correlated IN in
		// the outer join scans every visitor row again for every partner.
		// Deduplicate at partner level so visits across its stores count only once.
		partners, e := rows(ctx, tx, `WITH traffic AS (
 SELECT s.partner_id,sum(v.page_views)::bigint page_views,count(DISTINCT v.visitor_hash) FILTER(WHERE v.page_views>0) visitors
 FROM partner_stores s JOIN visitor_days v ON v.shop_id=s.id
 WHERE v.day BETWEEN $1 AND $2 GROUP BY s.partner_id
) SELECT p.id,p.name,p.slug,p.active::int,COALESCE(t.page_views,0)::bigint "pageViews",COALESCE(t.visitors,0)::bigint visitors
 FROM partners p LEFT JOIN traffic t ON t.partner_id=p.id
 ORDER BY visitors DESC,"pageViews" DESC,p.created_at DESC`, r.Start, r.End)
		if e != nil {
			return nil, e
		}
		out["partners"] = partners
	}
	return out, tx.Commit(ctx)
}
func (s Service) Ranking(ctx context.Context, days, page int) (map[string]any, error) {
	if (days != 1 && days != 7 && days != 30) || page < 1 || page > 10000 {
		return nil, fault.New(400, "时间范围或页码无效。")
	}
	now := time.Now().UnixMilli()
	since := (now+28800000)/86400000*86400000 - 28800000 - int64(days-1)*86400000
	tx, e := s.Store.DB.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	base := `WITH sales AS (SELECT partner_id,count(*) order_count FROM orders WHERE partner_id IS NOT NULL AND mode='live' AND is_test=0 AND payment_status='paid' AND status='success' AND refunded_cents<price_cents AND created_at BETWEEN $1 AND $2 GROUP BY partner_id) `
	list, e := rows(ctx, tx, base+`SELECT p.id,p.name,p.email,p.active::int,COALESCE(c.wechat,'') wechat,COALESCE(s.order_count,0) "orderCount" FROM partners p LEFT JOIN sales s ON s.partner_id=p.id LEFT JOIN support_contacts c ON c.owner=p.id ORDER BY "orderCount" DESC,p.created_at,p.id LIMIT 20 OFFSET $3`, since, now, (page-1)*20)
	if e != nil {
		return nil, e
	}
	for i, r := range list {
		r["rank"] = (page-1)*20 + i + 1
	}
	totals, e := rows(ctx, tx, base+`SELECT count(*) total,COALESCE(sum(s.order_count),0)::bigint "orderCount",count(s.partner_id) "sellingPartners" FROM partners p LEFT JOIN sales s ON s.partner_id=p.id`, since, now)
	if e != nil {
		return nil, e
	}
	out := totals[0]
	out["days"] = days
	out["page"] = page
	out["since"] = since
	out["until"] = now
	out["rows"] = list
	return out, tx.Commit(ctx)
}

type InterestInput struct {
	Token   string `json:"token"`
	Email   string `json:"email"`
	Product string `json:"product"`
	Consent bool   `json:"consent"`
}

func (s Service) Interest(ctx context.Context, in InterestInput, cancel bool) (map[string]any, error) {
	if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(in.Token) {
		return nil, fault.New(400, "登记凭据无效。")
	}
	hash := security.Hash(in.Token)
	if cancel {
		_, e := s.Store.DB.Exec(ctx, `DELETE FROM launch_interest WHERE token_hash=$1`, hash)
		return map[string]any{"ok": true}, e
	}
	email, e := auth.Email(in.Email)
	if e != nil {
		return nil, e
	}
	if !in.Consent || (in.Product != "claude" && in.Product != "grok" && in.Product != "gmail") {
		return nil, fault.New(400, "请核对商品并同意邮箱使用说明。")
	}
	if _, e = s.Store.DB.Exec(ctx, `INSERT INTO launch_interest(id,product,email,token_hash,consent_version) VALUES($1,$2,$3,$4,'launch-interest-v1') ON CONFLICT DO NOTHING`, security.ID(), in.Product, email, hash); e != nil {
		return nil, e
	}
	var manageable bool
	e = s.Store.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM launch_interest WHERE product=$1 AND email=$2 AND token_hash=$3)`, in.Product, email, hash).Scan(&manageable)
	return map[string]any{"ok": true, "manageable": manageable, "deliveryEnabled": false}, e
}
func (s Service) InterestList(ctx context.Context, page int) (map[string]any, error) {
	if page < 1 || page > 10000 {
		return nil, fault.New(400, "页码无效。")
	}
	list, e := rows(ctx, s.Store.DB, `SELECT id,product,email,consent_version,created_at FROM launch_interest ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET $1`, (page-1)*20)
	if e != nil {
		return nil, e
	}
	var total int64
	e = s.Store.DB.QueryRow(ctx, `SELECT count(*) FROM launch_interest`).Scan(&total)
	return map[string]any{"rows": list, "total": total, "page": page, "deliveryEnabled": false}, e
}
