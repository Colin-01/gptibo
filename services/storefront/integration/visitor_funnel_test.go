package integration_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"gptibo/storefront/internal/management"
	"gptibo/storefront/internal/security"
)

func TestVisitorFunnelDeduplicationAndPaymentDates(t *testing.T) {
	owner, app := fixture(t, true)
	ctx := context.Background()
	s := management.Service{Store: app}
	execSQL(t, owner, `INSERT INTO catalog_plans(id,product_id,name,price_cents) VALUES('plus','chatgpt','Plus',1000)`)
	execSQL(t, owner, `INSERT INTO partners(id,slug,name,active) VALUES('a','AAA001','A',true),('b','BBB001','B',false)`)
	execSQL(t, owner, `INSERT INTO partner_stores(id,partner_id,slot,slug,name) VALUES('second','a',2,'AAA002','Second')`)
	id := security.ID()
	if e := s.RecordVisitor(ctx, management.VisitorInput{VisitorID: id, Path: "/product/chatgpt", Event: "checkout"}); e != nil {
		t.Fatal(e)
	}
	eventOnly, e := s.Visitors(ctx, 7, "", false)
	if e != nil || eventOnly["visitors"] != int64(0) || eventOnly["pageViews"] != int64(0) || eventOnly["funnel"].(map[string]any)["checkoutVisitors"] != int64(1) {
		t.Fatal("behavior without a page open must not create UV/PV", eventOnly, e)
	}
	for _, event := range []string{"pageview", "checkout", "checkout", "payment", "payment"} {
		if e := s.RecordVisitor(ctx, management.VisitorInput{VisitorID: id, Path: "/product/chatgpt", Event: event}); e != nil {
			t.Fatal(e)
		}
	}
	if e := s.RecordVisitor(ctx, management.VisitorInput{VisitorID: security.ID(), Path: "/"}); e != nil {
		t.Fatal(e)
	}
	today, _ := management.ParseVisitorRange(url.Values{"period": {"today"}}, time.Now())
	out, e := s.VisitorsRange(ctx, today, "", false)
	if e != nil {
		t.Fatal(e)
	}
	f := out["funnel"].(map[string]any)
	if out["visitors"] != int64(2) || out["pageViews"] != int64(2) || out["effectiveVisitors"] != int64(1) || out["bounceRate"] != float64(100) || f["productVisitors"] != int64(1) || f["checkoutVisitors"] != int64(1) || f["paymentVisitors"] != int64(1) {
		t.Fatal("wrong metrics or behavior events inflated PV", out)
	}
	yesterday := time.UnixMilli(today.Since).AddDate(0, 0, -1).In(time.FixedZone("CST", 28800)).Format("2006-01-02")
	execSQL(t, owner, `INSERT INTO visitor_days(day,shop_id,visitor_hash,page_views,product_view,checkout_view,payment_view) VALUES($1,'second',$2,1,1,1,1)`, yesterday, security.Hash(id))
	overall, e := s.Visitors(ctx, 7, "", true)
	if e != nil {
		t.Fatal(e)
	}
	if overall["visitors"] != int64(2) || overall["pageViews"] != int64(3) || overall["effectiveVisitors"] != int64(1) || overall["bounceRate"] != float64(50) || overall["funnel"].(map[string]any)["checkoutVisitors"] != int64(1) {
		t.Fatal("period/cross-store deduplication failed", overall)
	}
	past, _ := management.ParseVisitorRange(url.Values{"start": {yesterday}, "end": {yesterday}}, time.Now())
	prior, e := s.VisitorsRange(ctx, past, "a", false)
	if e != nil || prior["visitors"] != int64(1) || prior["pageViews"] != int64(1) {
		t.Fatal("custom scope failed", prior, e)
	}
	for i, tc := range []struct {
		id, mode, payment, partner string
		test                       int
		at                         int64
	}{
		{"live", "live", "paid", "", 0, today.Since}, {"partner", "live", "paid", "a", 0, today.Until - 1},
		{"test", "live", "paid", "", 1, today.Since}, {"demo", "demo", "simulated", "", 0, today.Since},
		{"old", "live", "paid", "", 0, today.Since - 1}, {"future", "live", "paid", "", 0, today.Until},
		{"unpaid", "live", "unpaid", "", 0, today.Since},
	} {
		var partner any
		if tc.partner != "" {
			partner = tc.partner
		}
		execSQL(t, owner, `INSERT INTO orders(id,last_event_id,owner_hash,idempotency_key,plan,plan_name,price_cents,mode,status,payment_status,is_test,partner_id,created_at,updated_at) VALUES($1,'fixture','fixture',$1,'plus','Plus',1000,$2,'pending',$3,$4,$5,$6,$6)`, tc.id, tc.mode, tc.payment, tc.test, partner, time.Now().UnixMilli())
		execSQL(t, owner, `INSERT INTO order_events(id,order_id,actor,action,to_status,order_version,created_at) VALUES($1,$2,'payment','payment-confirmed','pending',0,$3)`, fmt.Sprint("event-", i), tc.id, tc.at)
	}
	execSQL(t, owner, `INSERT INTO order_events(id,order_id,actor,action,to_status,order_version,created_at) VALUES('duplicate','old','payment','payment-confirmed','pending',1,$1)`, today.Since)
	// Full refunds and later updates do not move or remove the original receipt.
	execSQL(t, owner, `UPDATE orders SET refunded_cents=price_cents,updated_at=$1 WHERE id='live'`, today.Until+86400000)
	for _, tc := range []struct {
		shop string
		paid int64
	}{{"", 2}, {"platform", 1}, {"a", 1}, {"b", 0}} {
		result, e := s.VisitorsRange(ctx, today, tc.shop, false)
		if e != nil {
			t.Fatal(e)
		}
		if result["funnel"].(map[string]any)["paidOrders"] != tc.paid {
			t.Fatal("wrong paid date or scope", tc.shop, result)
		}
	}
	for _, in := range []management.VisitorInput{{VisitorID: id, Path: "/admin"}, {VisitorID: id, Path: "/", Event: "paid"}, {VisitorID: "invalid", Path: "/"}, {VisitorID: id, Path: "/r/BBB001"}} {
		if s.RecordVisitor(ctx, in) == nil {
			t.Fatal("invalid visit accepted", in)
		}
	}
}

func TestVisitorHTTPStaffExclusionsAndRangeRoutes(t *testing.T) {
	owner, _, _, h, mail := identityFixture(t)
	execSQL(t, owner, `INSERT INTO partners(id,slug,name,email,active) VALUES('a','AAA001','A','partner@example.test',true)`)
	admin := login(t, h, mail, "admin", "")
	partner := login(t, h, mail, "partner", "partner@example.test")
	payload := map[string]any{"visitorId": security.ID(), "path": "/"}
	object(t, request(h, "POST", "/api/visitors", payload, admin), 200)
	object(t, request(h, "POST", "/api/visitors", payload, partner), 200)
	for _, ua := range []string{"Googlebot/2.1", "HeadlessChrome/140", "curl/8"} {
		r := httptest.NewRequest("POST", "/api/visitors", strings.NewReader(fmt.Sprintf(`{"visitorId":%q,"path":"/"}`, security.ID())))
		r.Header.Set("Origin", testOrigin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("User-Agent", ua)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		object(t, w, 200)
	}
	payload["automated"] = true
	object(t, request(h, "POST", "/api/visitors", payload, nil), 200)
	delete(payload, "automated")
	var n int
	if e := owner.DB.QueryRow(context.Background(), `SELECT count(*) FROM visitor_days`).Scan(&n); e != nil || n != 0 {
		t.Fatal("staff/robots counted", n, e)
	}
	stale := &http.Cookie{Name: admin.Name, Value: strings.Repeat("b", 64)}
	object(t, request(h, "POST", "/api/visitors", payload, stale), 200)
	execSQL(t, owner, `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE role='partner'`)
	payload["visitorId"] = security.ID()
	object(t, request(h, "POST", "/api/visitors", payload, partner), 200)
	if e := owner.DB.QueryRow(context.Background(), `SELECT count(*) FROM visitor_days`).Scan(&n); e != nil || n != 2 {
		t.Fatal("stale cookie suppressed genuine visits", n, e)
	}
	execSQL(t, owner, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE role='partner'`)
	day := time.Now().In(time.FixedZone("CST", 28800)).Format("2006-01-02")
	for _, route := range []struct {
		path   string
		cookie *http.Cookie
	}{{"/api/admin/visitors", admin}, {"/api/admin/partners/a/visitors", admin}, {"/api/partner/visitors", partner}} {
		for _, q := range []string{"period=today", "period=yesterday", "days=7", "days=30", "days=90", "start=" + day + "&end=" + day} {
			object(t, request(h, "GET", route.path+"?"+q, nil, route.cookie), 200)
		}
		object(t, request(h, "GET", route.path+"?start=2026-02-30&end="+day, nil, route.cookie), 400)
	}
}
