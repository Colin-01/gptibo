package httpapi

import (
	"github.com/gin-gonic/gin"
	"gptibo/storefront/internal/auth"
	"gptibo/storefront/internal/domains"
	"gptibo/storefront/internal/fault"
	"gptibo/storefront/internal/management"
	"strconv"
	"strings"
	"time"
)

func registerAnalytics(group, admin, partner *gin.RouterGroup, m management.Service, a *auth.Service, token func(*gin.Context, string) string) {
	number := func(c *gin.Context, key, value string) int {
		n, e := strconv.Atoi(c.DefaultQuery(key, value))
		if e != nil {
			return -1
		}
		return n
	}
	reply := func(c *gin.Context, out any, e error) {
		if e != nil {
			fail(c, e)
			return
		}
		c.JSON(200, out)
	}
	own := func(c *gin.Context) string { return c.MustGet("principal").(auth.Principal).Subject }
	visitors := func(c *gin.Context, shop string, isAdmin bool) {
		r, e := management.ParseVisitorRange(c.Request.URL.Query(), time.Now())
		if e != nil {
			fail(c, e)
			return
		}
		out, e := m.VisitorsRange(c.Request.Context(), r, shop, isAdmin)
		reply(c, out, e)
	}
	group.POST("/visitors", func(c *gin.Context) {
		var in management.VisitorInput
		if !readLimit(c, &in, 512) {
			return
		}
		if e := a.Limit(c.Request.Context(), "visitors:"+c.ClientIP(), 120, 60); e != nil {
			fail(c, e)
			return
		}
		if in.Automated || management.AutomatedVisitor(c.GetHeader("User-Agent")) {
			c.JSON(200, gin.H{"ok": true})
			return
		}
		for _, role := range []string{"admin", "partner"} {
			if value := token(c, role); value != "" {
				if _, e := a.Require(c.Request.Context(), m.Store.DB, role, value); e == nil {
					c.JSON(200, gin.H{"ok": true})
					return
				} else if fault.Status(e) != 401 {
					fail(c, e)
					return
				}
			}
		}
		if scope := domains.Current(c.Request.Context()); scope.Host != "" {
			if !strings.HasPrefix(in.Path, "/") {
				fail(c, fault.New(400, "页面路径无效。"))
				return
			}
			if strings.HasPrefix(in.Path, "/r/") || strings.HasPrefix(in.Path, "/s/") {
				parts := strings.Split(in.Path, "/")
				if len(parts) < 3 || parts[2] != scope.Slug {
					fail(c, fault.New(404, "商店不可用。"))
					return
				}
			} else {
				in.Path = "/r/" + scope.Slug + in.Path
			}

		}
		e := m.RecordVisitor(c.Request.Context(), in)
		reply(c, gin.H{"ok": true}, e)
	})
	partner.GET("/visitors", func(c *gin.Context) {
		visitors(c, own(c), false)
	})
	admin.GET("/visitors", func(c *gin.Context) {
		visitors(c, "", true)
	})
	admin.GET("/partners/:id/visitors", func(c *gin.Context) {
		if _, e := m.Partner(c.Request.Context(), c.Param("id")); e != nil {
			fail(c, e)
			return
		}
		visitors(c, c.Param("id"), false)
	})
	admin.GET("/partners/ranking", func(c *gin.Context) {
		out, e := m.Ranking(c.Request.Context(), number(c, "days", "1"), page(c))
		reply(c, out, e)
	})
	for _, cancel := range []bool{false, true} {
		path := "/interest"
		if cancel {
			path += "/cancel"
		}
		group.POST(path, func(c *gin.Context) {
			var in management.InterestInput
			if !read(c, &in) {
				return
			}
			if e := a.Limit(c.Request.Context(), "interest:"+c.ClientIP(), 30, 60); e != nil {
				fail(c, e)
				return
			}
			out, e := m.Interest(c.Request.Context(), in, cancel)
			reply(c, out, e)
		})
	}
	admin.GET("/interest", func(c *gin.Context) { out, e := m.InterestList(c.Request.Context(), page(c)); reply(c, out, e) })
}
