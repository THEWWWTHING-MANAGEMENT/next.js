import { createNextDescribe } from 'e2e-utils'
import crypto from 'crypto'
import { check, getRedboxHeader, hasRedbox, waitFor } from 'next-test-utils'
import cheerio from 'cheerio'
import stripAnsi from 'strip-ansi'

createNextDescribe(
  'app dir',
  {
    files: __dirname,
    dependencies: {
      swr: '2.0.0-rc.0',
      react: 'latest',
      'react-dom': 'latest',
      sass: 'latest',
    },
  },
  ({ next, isNextDev: isDev, isNextStart, isNextDeploy }) => {
    if (isDev) {
      it('should not have duplicate config warnings', async () => {
        await next.fetch('/')
        expect(
          stripAnsi(next.cliOutput).match(
            /You have enabled experimental feature/g
          ).length
        ).toBe(1)
        expect(
          stripAnsi(next.cliOutput).match(
            /Experimental features are not covered by semver/g
          ).length
        ).toBe(1)
      })
    }

    if (!isNextDeploy) {
      it('should not share edge workers', async () => {
        const controller1 = new AbortController()
        const controller2 = new AbortController()
        next
          .fetch('/slow-page-no-loading', {
            signal: controller1.signal,
          })
          .catch(() => {})
        next
          .fetch('/slow-page-no-loading', {
            signal: controller2.signal,
          })
          .catch(() => {})

        await waitFor(1000)
        controller1.abort()

        const controller3 = new AbortController()
        next
          .fetch('/slow-page-no-loading', {
            signal: controller3.signal,
          })
          .catch(() => {})
        await waitFor(1000)
        controller2.abort()
        controller3.abort()

        const res = await next.fetch('/slow-page-no-loading')
        expect(res.status).toBe(200)
        expect(await res.text()).toContain('hello from slow page')
        expect(next.cliOutput).not.toContain(
          'A separate worker must be used for each render'
        )
      })
    }

    if (isNextStart) {
      it('should generate build traces correctly', async () => {
        const trace = JSON.parse(
          await next.readFile(
            '.next/server/app/dashboard/deployments/[id]/page.js.nft.json'
          )
        ) as { files: string[] }
        expect(trace.files.some((file) => file.endsWith('data.json'))).toBe(
          true
        )
      })
    }

    it('should use text/x-component for flight', async () => {
      const res = await next.fetch('/dashboard/deployments/123', {
        headers: {
          ['RSC'.toString()]: '1',
        },
      })
      expect(res.headers.get('Content-Type')).toBe('text/x-component')
    })

    it('should use text/x-component for flight with edge runtime', async () => {
      const res = await next.fetch('/dashboard', {
        headers: {
          ['RSC'.toString()]: '1',
        },
      })
      expect(res.headers.get('Content-Type')).toBe('text/x-component')
    })

    it('should pass props from getServerSideProps in root layout', async () => {
      const $ = await next.render$('/dashboard')
      expect($('title').first().text()).toBe('hello world')
    })

    it('should serve from pages', async () => {
      const html = await next.render('/')
      expect(html).toContain('hello from pages/index')

      // esm imports should work fine in pages/
      expect(html).toContain('swr-index')
    })

    it('should serve dynamic route from pages', async () => {
      const html = await next.render('/blog/first')
      expect(html).toContain('hello from pages/blog/[slug]')
    })

    it('should serve from public', async () => {
      const html = await next.render('/hello.txt')
      expect(html).toContain('hello world')
    })

    it('should serve from app', async () => {
      const html = await next.render('/dashboard')
      expect(html).toContain('hello from app/dashboard')
    })

    if (!isNextDeploy) {
      it('should serve /index as separate page', async () => {
        const stderr = []
        next.on('stderr', (err) => {
          stderr.push(err)
        })
        const html = await next.render('/dashboard/index')
        expect(html).toContain('hello from app/dashboard/index')
        expect(stderr.some((err) => err.includes('Invalid hook call'))).toBe(
          false
        )
      })

      it('should serve polyfills for browsers that do not support modules', async () => {
        const html = await next.render('/dashboard/index')
        expect(html).toMatch(
          /<script src="\/_next\/static\/chunks\/polyfills(-\w+)?\.js" nomodule="">/
        )
      })
    }

    // TODO-APP: handle css modules fouc in dev
    it.skip('should handle css imports in next/dynamic correctly', async () => {
      const browser = await next.browser('/dashboard/index')

      expect(
        await browser.eval(
          `window.getComputedStyle(document.querySelector('#css-text-dynamic-server')).color`
        )
      ).toBe('rgb(0, 0, 255)')
      expect(
        await browser.eval(
          `window.getComputedStyle(document.querySelector('#css-text-lazy')).color`
        )
      ).toBe('rgb(128, 0, 128)')
    })

    it('should include layouts when no direct parent layout', async () => {
      const $ = await next.render$('/dashboard/integrations')
      // Should not be nested in dashboard
      expect($('h1').text()).toBe('Dashboard')
      // Should include the page text
      expect($('p').text()).toBe('hello from app/dashboard/integrations')
    })

    // TODO-APP: handle new root layout
    it.skip('should not include parent when not in parent directory with route in directory', async () => {
      const $ = await next.render$('/dashboard/hello')
      const html = $.html()

      // new root has to provide it's own custom root layout or the default
      // is used instead
      expect(html).toContain('<html')
      expect(html).toContain('<body')
      expect($('html').hasClass('this-is-the-document-html')).toBeFalsy()
      expect($('body').hasClass('this-is-the-document-body')).toBeFalsy()

      // Should not be nested in dashboard
      expect($('h1').text()).toBeFalsy()

      // Should render the page text
      expect($('p').text()).toBe('hello from app/dashboard/rootonly/hello')
    })

    it('should use new root layout when provided', async () => {
      const $ = await next.render$('/dashboard/another')

      // new root has to provide it's own custom root layout or the default
      // is used instead
      expect($('html').hasClass('this-is-another-document-html')).toBeTruthy()
      expect($('body').hasClass('this-is-another-document-body')).toBeTruthy()

      // Should not be nested in dashboard
      expect($('h1').text()).toBeFalsy()

      // Should render the page text
      expect($('p').text()).toBe('hello from newroot/dashboard/another')
    })

    it('should not create new root layout when nested (optional)', async () => {
      const $ = await next.render$('/dashboard/deployments/breakdown')

      // new root has to provide it's own custom root layout or the default
      // is used instead
      expect($('html').hasClass('this-is-the-document-html')).toBeTruthy()
      expect($('body').hasClass('this-is-the-document-body')).toBeTruthy()

      // Should be nested in dashboard
      expect($('h1').text()).toBe('Dashboard')
      expect($('h2').text()).toBe('Custom dashboard')

      // Should render the page text
      expect($('p').text()).toBe(
        'hello from app/dashboard/(custom)/deployments/breakdown'
      )
    })

    it('should include parent document when no direct parent layout', async () => {
      const $ = await next.render$('/dashboard/integrations')

      expect($('html').hasClass('this-is-the-document-html')).toBeTruthy()
      expect($('body').hasClass('this-is-the-document-body')).toBeTruthy()
    })

    it('should not include parent when not in parent directory', async () => {
      const $ = await next.render$('/dashboard/changelog')
      // Should not be nested in dashboard
      expect($('h1').text()).toBeFalsy()
      // Should include the page text
      expect($('p').text()).toBe('hello from app/dashboard/changelog')
    })

    it('should serve nested parent', async () => {
      const $ = await next.render$('/dashboard/deployments/123')
      // Should be nested in dashboard
      expect($('h1').text()).toBe('Dashboard')
      // Should be nested in deployments
      expect($('h2').text()).toBe('Deployments hello')
    })

    it('should serve dynamic parameter', async () => {
      const $ = await next.render$('/dashboard/deployments/123')
      // Should include the page text with the parameter
      expect($('p').text()).toBe(
        'hello from app/dashboard/deployments/[id]. ID is: 123'
      )
    })

    // TODO-APP: fix to ensure behavior matches on deploy
    if (!isNextDeploy) {
      it('should serve page as a segment name correctly', async () => {
        const html = await next.render('/dashboard/page')
        expect(html).toContain('hello dashboard/page!')
      })
    }

    it('should include document html and body', async () => {
      const $ = await next.render$('/dashboard')

      expect($('html').hasClass('this-is-the-document-html')).toBeTruthy()
      expect($('body').hasClass('this-is-the-document-body')).toBeTruthy()
    })

    it('should not serve when layout is provided but no folder index', async () => {
      const res = await next.fetch('/dashboard/deployments')
      expect(res.status).toBe(404)
      expect(await res.text()).toContain('This page could not be found')
    })

    // TODO-APP: do we want to make this only work for /root or is it allowed
    // to work for /pages as well?
    it.skip('should match partial parameters', async () => {
      const html = await next.render('/partial-match-123')
      expect(html).toContain('hello from app/partial-match-[id]. ID is: 123')
    })

    describe('rewrites', () => {
      // TODO-APP: rewrite url is broken
      it('should support rewrites on initial load', async () => {
        const browser = await next.browser('/rewritten-to-dashboard')
        expect(await browser.elementByCss('h1').text()).toBe('Dashboard')
        expect(await browser.url()).toBe(`${next.url}/rewritten-to-dashboard`)
      })

      it('should support rewrites on client-side navigation from pages to app with existing pages path', async () => {
        const browser = await next.browser('/link-to-rewritten-path')

        try {
          // Click the link.
          await browser.elementById('link-to-rewritten-path').click()
          await browser.waitForElementByCss('#from-dashboard')

          // Check to see that we were rewritten and not redirected.
          // TODO-APP: rewrite url is broken
          // expect(await browser.url()).toBe(`${next.url}/rewritten-to-dashboard`)

          // Check to see that the page we navigated to is in fact the dashboard.
          expect(await browser.elementByCss('#from-dashboard').text()).toBe(
            'hello from app/dashboard'
          )
        } finally {
          await browser.close()
        }
      })

      it('should support rewrites on client-side navigation', async () => {
        const browser = await next.browser('/rewrites')

        try {
          // Click the link.
          await browser.elementById('link').click()
          await browser.waitForElementByCss('#from-dashboard')

          // Check to see that we were rewritten and not redirected.
          expect(await browser.url()).toBe(`${next.url}/rewritten-to-dashboard`)

          // Check to see that the page we navigated to is in fact the dashboard.
          expect(await browser.elementByCss('#from-dashboard').text()).toBe(
            'hello from app/dashboard'
          )
        } finally {
          await browser.close()
        }
      })
    })

    // TODO-APP: Enable in development
    ;(isDev ? it.skip : it)(
      'should not rerender layout when navigating between routes in the same layout',
      async () => {
        const browser = await next.browser('/same-layout/first')

        try {
          // Get the render id from the dom and click the first link.
          const firstRenderID = await browser.elementById('render-id').text()
          await browser.elementById('link').click()
          await browser.waitForElementByCss('#second-page')

          // Get the render id from the dom again, it should be the same!
          const secondRenderID = await browser.elementById('render-id').text()
          expect(secondRenderID).toBe(firstRenderID)

          // Navigate back to the first page again by clicking the link.
          await browser.elementById('link').click()
          await browser.waitForElementByCss('#first-page')

          // Get the render id from the dom again, it should be the same!
          const thirdRenderID = await browser.elementById('render-id').text()
          expect(thirdRenderID).toBe(firstRenderID)
        } finally {
          await browser.close()
        }
      }
    )

    it('should handle hash in initial url', async () => {
      const browser = await next.browser('/dashboard#abc')

      try {
        // Check if hash is preserved
        expect(await browser.eval('window.location.hash')).toBe('#abc')
        await waitFor(1000)
        // Check again to be sure as it might be timed different
        expect(await browser.eval('window.location.hash')).toBe('#abc')
      } finally {
        await browser.close()
      }
    })

    describe('<Link />', () => {
      it('should hard push', async () => {
        const browser = await next.browser('/link-hard-push/123')

        try {
          // Click the link on the page, and verify that the history entry was
          // added.
          expect(await browser.eval('window.history.length')).toBe(2)
          await browser.elementById('link').click()
          await browser.waitForElementByCss('#render-id-456')
          expect(await browser.eval('window.history.length')).toBe(3)

          // Get the id on the rendered page.
          const firstID = await browser.elementById('render-id-456').text()

          // Go back, and redo the navigation by clicking the link.
          await browser.back()
          await browser.elementById('link').click()
          await browser.waitForElementByCss('#render-id-456')

          // Get the id again, and compare, they should not be the same.
          const secondID = await browser.elementById('render-id-456').text()
          expect(secondID).not.toBe(firstID)
        } finally {
          await browser.close()
        }
      })

      it('should hard replace', async () => {
        const browser = await next.browser('/link-hard-replace/123')

        try {
          // Click the link on the page, and verify that the history entry was NOT
          // added.
          expect(await browser.eval('window.history.length')).toBe(2)
          await browser.elementById('link').click()
          await browser.waitForElementByCss('#render-id-456')
          expect(await browser.eval('window.history.length')).toBe(2)

          // Get the date again, and compare, they should not be the same.
          const firstId = await browser.elementById('render-id-456').text()

          // Navigate to the subpage, verify that the history entry was NOT added.
          await browser.elementById('link').click()
          await browser.waitForElementByCss('#render-id-123')
          expect(await browser.eval('window.history.length')).toBe(2)

          // Navigate back again, verify that the history entry was NOT added.
          await browser.elementById('link').click()
          await browser.waitForElementByCss('#render-id-456')
          expect(await browser.eval('window.history.length')).toBe(2)

          // Get the date again, and compare, they should not be the same.
          const secondId = await browser.elementById('render-id-456').text()
          expect(firstId).not.toBe(secondId)
        } finally {
          await browser.close()
        }
      })

      // TODO-APP: Re-enable this test.
      it('should soft push', async () => {
        const browser = await next.browser('/link-soft-push')

        try {
          // Click the link on the page, and verify that the history entry was
          // added.
          expect(await browser.eval('window.history.length')).toBe(2)
          await browser.elementById('link').click()
          await browser.waitForElementByCss('#render-id')
          expect(await browser.eval('window.history.length')).toBe(3)

          // Get the id on the rendered page.
          const firstID = await browser.elementById('render-id').text()

          // Go back, and redo the navigation by clicking the link.
          await browser.back()
          await browser.elementById('link').click()

          // Get the date again, and compare, they should be the same.
          const secondID = await browser.elementById('render-id').text()
          expect(firstID).toBe(secondID)
        } finally {
          await browser.close()
        }
      })

      // TODO-APP: investigate this test
      it.skip('should soft replace', async () => {
        const browser = await next.browser('/link-soft-replace')

        try {
          // Get the render ID so we can compare it.
          const firstID = await browser.elementById('render-id').text()

          // Click the link on the page, and verify that the history entry was NOT
          // added.
          expect(await browser.eval('window.history.length')).toBe(2)
          await browser.elementById('self-link').click()
          await browser.waitForElementByCss('#render-id')
          expect(await browser.eval('window.history.length')).toBe(2)

          // Get the id on the rendered page.
          const secondID = await browser.elementById('render-id').text()
          expect(secondID).toBe(firstID)

          // Navigate to the subpage, verify that the history entry was NOT added.
          await browser.elementById('subpage-link').click()
          await browser.waitForElementByCss('#back-link')
          expect(await browser.eval('window.history.length')).toBe(2)

          // Navigate back again, verify that the history entry was NOT added.
          await browser.elementById('back-link').click()
          await browser.waitForElementByCss('#render-id')
          expect(await browser.eval('window.history.length')).toBe(2)

          // Get the date again, and compare, they should be the same.
          const thirdID = await browser.elementById('render-id').text()
          expect(thirdID).toBe(firstID)
        } finally {
          await browser.close()
        }
      })

      it('should be soft for back navigation', async () => {
        const browser = await next.browser('/with-id')

        try {
          // Get the id on the rendered page.
          const firstID = await browser.elementById('render-id').text()

          // Click the link, and go back.
          await browser.elementById('link').click()
          await browser.waitForElementByCss('#from-navigation')
          await browser.back()

          // Get the date again, and compare, they should be the same.
          const secondID = await browser.elementById('render-id').text()
          expect(firstID).toBe(secondID)
        } finally {
          await browser.close()
        }
      })

      it('should be soft for forward navigation', async () => {
        const browser = await next.browser('/with-id')

        try {
          // Click the link.
          await browser.elementById('link').click()
          await browser.waitForElementByCss('#from-navigation')

          // Get the id on the rendered page.
          const firstID = await browser.elementById('render-id').text()

          // Go back, then forward.
          await browser.back()
          await browser.forward()

          // Get the date again, and compare, they should be the same.
          const secondID = await browser.elementById('render-id').text()
          expect(firstID).toBe(secondID)
        } finally {
          await browser.close()
        }
      })

      it('should allow linking from app page to pages page', async () => {
        const browser = await next.browser('/pages-linking')

        try {
          // Click the link.
          await browser.elementById('app-link').click()
          expect(await browser.waitForElementByCss('#pages-link').text()).toBe(
            'To App Page'
          )

          // Click the other link.
          await browser.elementById('pages-link').click()
          expect(await browser.waitForElementByCss('#app-link').text()).toBe(
            'To Pages Page'
          )
        } finally {
          await browser.close()
        }
      })

      it('should navigate to pages dynamic route from pages page if it overlaps with an app page', async () => {
        const browser = await next.browser('/dynamic-pages-route-app-overlap')

        try {
          // Click the link.
          await browser.elementById('pages-link').click()
          expect(await browser.waitForElementByCss('#pages-text').text()).toBe(
            'hello from pages/dynamic-pages-route-app-overlap/[slug]'
          )

          // When refreshing the browser, the app page should be rendered
          await browser.refresh()
          expect(await browser.waitForElementByCss('#app-text').text()).toBe(
            'hello from app/dynamic-pages-route-app-overlap/app-dir/page'
          )
        } finally {
          await browser.close()
        }
      })

      it('should push to external url', async () => {
        const browser = await next.browser('/link-external/push')
        expect(await browser.eval('window.history.length')).toBe(2)
        await browser.elementByCss('#external-link').click()
        expect(await browser.waitForElementByCss('h1').text()).toBe(
          'Example Domain'
        )
        expect(await browser.eval('window.history.length')).toBe(3)
      })

      it('should replace to external url', async () => {
        const browser = await next.browser('/link-external/replace')
        expect(await browser.eval('window.history.length')).toBe(2)
        await browser.elementByCss('#external-link').click()
        expect(await browser.waitForElementByCss('h1').text()).toBe(
          'Example Domain'
        )
        expect(await browser.eval('window.history.length')).toBe(2)
      })
    })

    describe('server components', () => {
      // TODO-APP: why is this not servable but /dashboard+rootonly/hello.server.js
      // should be? Seems like they both either should be servable or not
      it('should not serve .server.js as a path', async () => {
        // Without .server.js should serve
        const html = await next.render('/should-not-serve-server')
        expect(html).toContain('hello from app/should-not-serve-server')

        // Should not serve `.server`
        const res = await next.fetch('/should-not-serve-server.server')
        expect(res.status).toBe(404)
        expect(await res.text()).toContain('This page could not be found')

        // Should not serve `.server.js`
        const res2 = await next.fetch('/should-not-serve-server.server.js')
        expect(res2.status).toBe(404)
        expect(await res2.text()).toContain('This page could not be found')
      })

      it('should not serve .client.js as a path', async () => {
        // Without .client.js should serve
        const html = await next.render('/should-not-serve-client')
        expect(html).toContain('hello from app/should-not-serve-client')

        // Should not serve `.client`
        const res = await next.fetch('/should-not-serve-client.client')
        expect(res.status).toBe(404)
        expect(await res.text()).toContain('This page could not be found')

        // Should not serve `.client.js`
        const res2 = await next.fetch('/should-not-serve-client.client.js')
        expect(res2.status).toBe(404)
        expect(await res2.text()).toContain('This page could not be found')
      })

      it('should serve shared component', async () => {
        // Without .client.js should serve
        const html = await next.render('/shared-component-route')
        expect(html).toContain('hello from app/shared-component-route')
      })

      describe('dynamic routes', () => {
        it('should only pass params that apply to the layout', async () => {
          const $ = await next.render$('/dynamic/books/hello-world')

          expect($('#dynamic-layout-params').text()).toBe('{}')
          expect($('#category-layout-params').text()).toBe(
            '{"category":"books"}'
          )
          expect($('#id-layout-params').text()).toBe(
            '{"category":"books","id":"hello-world"}'
          )
          expect($('#id-page-params').text()).toBe(
            '{"category":"books","id":"hello-world"}'
          )
        })
      })

      describe('catch-all routes', () => {
        it('should handle optional segments', async () => {
          const params = ['this', 'is', 'a', 'test']
          const route = params.join('/')
          const $ = await next.render$(`/catch-all-optional/${route}`)
          expect($('#text').attr('data-params')).toBe(route)
        })

        it('should handle optional segments root', async () => {
          const $ = await next.render$(`/catch-all-optional`)
          expect($('#text').attr('data-params')).toBe('')
        })

        it('should handle optional catch-all segments link', async () => {
          const browser = await next.browser('/catch-all-link')
          expect(
            await browser
              .elementByCss('#to-catch-all-optional')
              .click()
              .waitForElementByCss('#text')
              .text()
          ).toBe(`hello from /catch-all-optional/this/is/a/test`)
        })

        it('should handle required segments', async () => {
          const params = ['this', 'is', 'a', 'test']
          const route = params.join('/')
          const $ = await next.render$(`/catch-all/${route}`)
          expect($('#text').attr('data-params')).toBe(route)
          expect($('#not-a-page').text()).toBe('Not a page')

          // Components under catch-all should not be treated as route that errors during build.
          // They should be rendered properly when imported in page route.
          expect($('#widget').text()).toBe('widget')
        })

        it('should handle required segments root as not found', async () => {
          const res = await next.fetch(`/catch-all`)
          expect(res.status).toBe(404)
          expect(await res.text()).toContain('This page could not be found')
        })

        it('should handle catch-all segments link', async () => {
          const browser = await next.browser('/catch-all-link')
          expect(
            await browser
              .elementByCss('#to-catch-all')
              .click()
              .waitForElementByCss('#text')
              .text()
          ).toBe(`hello from /catch-all/this/is/a/test`)
        })
      })

      describe('should serve client component', () => {
        it('should serve server-side', async () => {
          const $ = await next.render$('/client-component-route')
          expect($('p').text()).toBe(
            'hello from app/client-component-route. count: 0'
          )
        })

        // TODO-APP: investigate hydration not kicking in on some runs
        it('should serve client-side', async () => {
          const browser = await next.browser('/client-component-route')

          // After hydration count should be 1
          expect(await browser.elementByCss('p').text()).toBe(
            'hello from app/client-component-route. count: 1'
          )
        })
      })

      describe('should include client component layout with server component route', () => {
        it('should include it server-side', async () => {
          const $ = await next.render$('/client-nested')
          // Should not be nested in dashboard
          expect($('h1').text()).toBe('Client Nested. Count: 0')
          // Should include the page text
          expect($('p').text()).toBe('hello from app/client-nested')
        })

        it('should include it client-side', async () => {
          const browser = await next.browser('/client-nested')

          // After hydration count should be 1
          expect(await browser.elementByCss('h1').text()).toBe(
            'Client Nested. Count: 1'
          )

          // After hydration count should be 1
          expect(await browser.elementByCss('p').text()).toBe(
            'hello from app/client-nested'
          )
        })
      })

      describe('Loading', () => {
        it('should render loading.js in initial html for slow page', async () => {
          const $ = await next.render$('/slow-page-with-loading')

          expect($('#loading').text()).toBe('Loading...')
        })

        it('should render loading.js in browser for slow page', async () => {
          const browser = await next.browser('/slow-page-with-loading', {
            waitHydration: false,
          })
          // TODO-APP: `await next.browser()` causes waiting for the full page to complete streaming. At that point "Loading..." is replaced by the actual content
          // expect(await browser.elementByCss('#loading').text()).toBe('Loading...')

          expect(await browser.elementByCss('#slow-page-message').text()).toBe(
            'hello from slow page'
          )
        })

        it('should render loading.js in initial html for slow layout', async () => {
          const $ = await next.render$('/slow-layout-with-loading/slow')

          expect($('#loading').text()).toBe('Loading...')
        })

        it('should render loading.js in browser for slow layout', async () => {
          const browser = await next.browser('/slow-layout-with-loading/slow', {
            waitHydration: false,
          })
          // TODO-APP: `await next.browser()` causes waiting for the full page to complete streaming. At that point "Loading..." is replaced by the actual content
          // expect(await browser.elementByCss('#loading').text()).toBe('Loading...')

          expect(
            await browser.elementByCss('#slow-layout-message').text()
          ).toBe('hello from slow layout')

          expect(await browser.elementByCss('#page-message').text()).toBe(
            'Hello World'
          )
        })

        it('should render loading.js in initial html for slow layout and page', async () => {
          const $ = await next.render$(
            '/slow-layout-and-page-with-loading/slow'
          )

          expect($('#loading-layout').text()).toBe('Loading layout...')
          expect($('#loading-page').text()).toBe('Loading page...')
        })

        it('should render loading.js in browser for slow layout and page', async () => {
          const browser = await next.browser(
            '/slow-layout-and-page-with-loading/slow',
            {
              waitHydration: false,
            }
          )
          // TODO-APP: `await next.browser()` causes waiting for the full page to complete streaming. At that point "Loading..." is replaced by the actual content
          // expect(await browser.elementByCss('#loading-layout').text()).toBe('Loading...')
          // expect(await browser.elementByCss('#loading-page').text()).toBe('Loading...')

          expect(
            await browser.elementByCss('#slow-layout-message').text()
          ).toBe('hello from slow layout')

          expect(await browser.elementByCss('#slow-page-message').text()).toBe(
            'hello from slow page'
          )
        })
      })

      describe('middleware', () => {
        it.each(['rewrite', 'redirect'])(
          `should strip internal query parameters from requests to middleware for %s`,
          async (method) => {
            const browser = await next.browser('/internal')

            try {
              // Wait for and click the navigation element, this should trigger
              // the flight request that'll be caught by the middleware. If the
              // middleware sees any flight data on the request it'll redirect to
              // a page with an element of #failure, otherwise, we'll see the
              // element for #success.
              await browser
                .waitForElementByCss(`#navigate-${method}`)
                .elementById(`navigate-${method}`)
                .click()
              expect(
                await browser.waitForElementByCss('#success', 3000).text()
              ).toBe('Success')
            } finally {
              await browser.close()
            }
          }
        )
      })

      describe('next/router', () => {
        it('should support router.back and router.forward', async () => {
          const browser = await next.browser('/back-forward/1')

          const firstMessage = 'Hello from 1'
          const secondMessage = 'Hello from 2'

          expect(await browser.elementByCss('#message-1').text()).toBe(
            firstMessage
          )

          try {
            const message2 = await browser
              .waitForElementByCss('#to-other-page')
              .click()
              .waitForElementByCss('#message-2')
              .text()
            expect(message2).toBe(secondMessage)

            const message1 = await browser
              .waitForElementByCss('#back-button')
              .click()
              .waitForElementByCss('#message-1')
              .text()
            expect(message1).toBe(firstMessage)

            const message2Again = await browser
              .waitForElementByCss('#forward-button')
              .click()
              .waitForElementByCss('#message-2')
              .text()
            expect(message2Again).toBe(secondMessage)
          } finally {
            await browser.close()
          }
        })
      })

      describe('client components', () => {
        if (!isNextDeploy) {
          it('should have consistent query and params handling', async () => {
            const $ = await next.render$('/param-and-query/params?slug=query')
            const el = $('#params-and-query')
            expect(el.attr('data-params')).toBe('params')
            expect(el.attr('data-query')).toBe('query')
          })
        }
      })
    })

    if (isDev) {
      describe('HMR', () => {
        it('should HMR correctly for server component', async () => {
          const filePath = 'app/dashboard/index/page.js'
          const origContent = await next.readFile(filePath)

          try {
            const browser = await next.browser('/dashboard/index')
            expect(await browser.elementByCss('p').text()).toContain(
              'hello from app/dashboard/index'
            )

            await next.patchFile(
              filePath,
              origContent.replace('hello from', 'swapped from')
            )

            await check(() => browser.elementByCss('p').text(), /swapped from/)
          } finally {
            await next.patchFile(filePath, origContent)
          }
        })

        it('should HMR correctly for client component', async () => {
          const filePath = 'app/client-component-route/page.js'
          const origContent = await next.readFile(filePath)

          try {
            const browser = await next.browser('/client-component-route')

            const ssrInitial = await next.render('/client-component-route')

            expect(ssrInitial).toContain(
              'hello from app/client-component-route'
            )

            expect(await browser.elementByCss('p').text()).toContain(
              'hello from app/client-component-route'
            )

            await next.patchFile(
              filePath,
              origContent.replace('hello from', 'swapped from')
            )

            await check(() => browser.elementByCss('p').text(), /swapped from/)

            const ssrUpdated = await next.render('/client-component-route')
            expect(ssrUpdated).toContain('swapped from')

            await next.patchFile(filePath, origContent)

            await check(() => browser.elementByCss('p').text(), /hello from/)
            expect(await next.render('/client-component-route')).toContain(
              'hello from'
            )
          } finally {
            await next.patchFile(filePath, origContent)
          }
        })

        it('should HMR correctly when changing the component type', async () => {
          const filePath = 'app/dashboard/page/page.jsx'
          const origContent = await next.readFile(filePath)

          try {
            const browser = await next.browser('/dashboard/page')

            expect(await browser.elementByCss('p').text()).toContain(
              'hello dashboard/page!'
            )

            // Test HMR with server component
            await next.patchFile(
              filePath,
              origContent.replace(
                'hello dashboard/page!',
                'hello dashboard/page in server component!'
              )
            )
            await check(
              () => browser.elementByCss('p').text(),
              /in server component/
            )

            // Change to client component
            await next.patchFile(
              filePath,
              origContent
                .replace("// 'use client'", "'use client'")
                .replace(
                  'hello dashboard/page!',
                  'hello dashboard/page in client component!'
                )
            )
            await check(
              () => browser.elementByCss('p').text(),
              /in client component/
            )

            // Change back to server component
            await next.patchFile(
              filePath,
              origContent.replace(
                'hello dashboard/page!',
                'hello dashboard/page in server component2!'
              )
            )
            await check(
              () => browser.elementByCss('p').text(),
              /in server component2/
            )

            // Change to client component again
            await next.patchFile(
              filePath,
              origContent
                .replace("// 'use client'", "'use client'")
                .replace(
                  'hello dashboard/page!',
                  'hello dashboard/page in client component2!'
                )
            )
            await check(
              () => browser.elementByCss('p').text(),
              /in client component2/
            )
          } finally {
            await next.patchFile(filePath, origContent)
          }
        })
      })
    }

    describe('searchParams prop', () => {
      describe('client component', () => {
        it('should have the correct search params', async () => {
          const $ = await next.render$(
            '/search-params-prop?first=value&second=other%20value&third'
          )
          const el = $('#params')
          expect(el.attr('data-param-first')).toBe('value')
          expect(el.attr('data-param-second')).toBe('other value')
          expect(el.attr('data-param-third')).toBe('')
          expect(el.attr('data-param-not-real')).toBe('N/A')
        })

        it('should have the correct search params on rewrite', async () => {
          const $ = await next.render$('/search-params-prop-rewrite')
          const el = $('#params')
          expect(el.attr('data-param-first')).toBe('value')
          expect(el.attr('data-param-second')).toBe('other value')
          expect(el.attr('data-param-third')).toBe('')
          expect(el.attr('data-param-not-real')).toBe('N/A')
        })

        it('should have the correct search params on middleware rewrite', async () => {
          const $ = await next.render$('/search-params-prop-middleware-rewrite')
          const el = $('#params')
          expect(el.attr('data-param-first')).toBe('value')
          expect(el.attr('data-param-second')).toBe('other value')
          expect(el.attr('data-param-third')).toBe('')
          expect(el.attr('data-param-not-real')).toBe('N/A')
        })
      })

      describe('server component', () => {
        it('should have the correct search params', async () => {
          const $ = await next.render$(
            '/search-params-prop/server?first=value&second=other%20value&third'
          )
          const el = $('#params')
          expect(el.attr('data-param-first')).toBe('value')
          expect(el.attr('data-param-second')).toBe('other value')
          expect(el.attr('data-param-third')).toBe('')
          expect(el.attr('data-param-not-real')).toBe('N/A')
        })

        it('should have the correct search params on rewrite', async () => {
          const $ = await next.render$('/search-params-prop-server-rewrite')
          const el = $('#params')
          expect(el.attr('data-param-first')).toBe('value')
          expect(el.attr('data-param-second')).toBe('other value')
          expect(el.attr('data-param-third')).toBe('')
          expect(el.attr('data-param-not-real')).toBe('N/A')
        })

        it('should have the correct search params on middleware rewrite', async () => {
          const $ = await next.render$(
            '/search-params-prop-server-middleware-rewrite'
          )
          const el = $('#params')
          expect(el.attr('data-param-first')).toBe('value')
          expect(el.attr('data-param-second')).toBe('other value')
          expect(el.attr('data-param-third')).toBe('')
          expect(el.attr('data-param-not-real')).toBe('N/A')
        })
      })
    })
    ;(isDev || isNextDeploy ? describe.skip : describe)(
      'Subresource Integrity',
      () => {
        function fetchWithPolicy(policy: string | null) {
          return next.fetch('/dashboard', {
            headers: policy
              ? {
                  'Content-Security-Policy': policy,
                }
              : {},
          })
        }

        async function renderWithPolicy(policy: string | null) {
          const res = await fetchWithPolicy(policy)

          expect(res.ok).toBe(true)

          const html = await res.text()

          return cheerio.load(html)
        }

        it('does not include nonce when not enabled', async () => {
          const policies = [
            `script-src 'nonce-'`, // invalid nonce
            'style-src "nonce-cmFuZG9tCg=="', // no script or default src
            '', // empty string
          ]

          for (const policy of policies) {
            const $ = await renderWithPolicy(policy)

            // Find all the script tags without src attributes and with nonce
            // attributes.
            const elements = $('script[nonce]:not([src])')

            // Expect there to be none.
            expect(elements.length).toBe(0)
          }
        })

        it('includes a nonce value with inline scripts when Content-Security-Policy header is defined', async () => {
          // A random nonce value, base64 encoded.
          const nonce = 'cmFuZG9tCg=='

          // Validate all the cases where we could parse the nonce.
          const policies = [
            `script-src 'nonce-${nonce}'`, // base case
            `   script-src   'nonce-${nonce}' `, // extra space added around sources and directive
            `style-src 'self'; script-src 'nonce-${nonce}'`, // extra directives
            `script-src 'self' 'nonce-${nonce}' 'nonce-othernonce'`, // extra nonces
            `default-src 'nonce-othernonce'; script-src 'nonce-${nonce}';`, // script and then fallback case
            `default-src 'nonce-${nonce}'`, // fallback case
          ]

          for (const policy of policies) {
            const $ = await renderWithPolicy(policy)

            // Find all the script tags without src attributes.
            const elements = $('script:not([src])')

            // Expect there to be at least 1 script tag without a src attribute.
            expect(elements.length).toBeGreaterThan(0)

            // Expect all inline scripts to have the nonce value.
            elements.each((i, el) => {
              expect(el.attribs['nonce']).toBe(nonce)
            })
          }
        })

        it('includes an integrity attribute on scripts', async () => {
          const $ = await next.render$('/dashboard')

          // Find all the script tags with src attributes.
          const elements = $('script[src]')

          // Expect there to be at least 1 script tag with a src attribute.
          expect(elements.length).toBeGreaterThan(0)

          // Collect all the scripts with integrity hashes so we can verify them.
          const files: [string, string][] = []

          // For each of these attributes, ensure that there's an integrity
          // attribute and starts with the correct integrity hash prefix.
          elements.each((i, el) => {
            const integrity = el.attribs['integrity']
            expect(integrity).toBeDefined()
            expect(integrity).toStartWith('sha256-')

            const src = el.attribs['src']
            expect(src).toBeDefined()

            files.push([src, integrity])
          })

          // For each script tag, ensure that the integrity attribute is the
          // correct hash of the script tag.
          for (const [src, integrity] of files) {
            const res = await next.fetch(src)
            expect(res.status).toBe(200)
            const content = await res.text()

            const hash = crypto
              .createHash('sha256')
              .update(content)
              .digest()
              .toString('base64')

            expect(integrity).toEndWith(hash)
          }
        })

        it('throws when escape characters are included in nonce', async () => {
          const res = await fetchWithPolicy(
            `script-src 'nonce-"><script></script>"'`
          )

          expect(res.status).toBe(500)
        })
      }
    )

    describe('template component', () => {
      it('should render the template that holds state in a client component and reset on navigation', async () => {
        const browser = await next.browser('/template/clientcomponent')
        expect(await browser.elementByCss('h1').text()).toBe('Template 0')
        await browser.elementByCss('button').click()
        expect(await browser.elementByCss('h1').text()).toBe('Template 1')

        await browser.elementByCss('#link').click()
        await browser.waitForElementByCss('#other-page')

        expect(await browser.elementByCss('h1').text()).toBe('Template 0')
        await browser.elementByCss('button').click()
        expect(await browser.elementByCss('h1').text()).toBe('Template 1')

        await browser.elementByCss('#link').click()
        await browser.waitForElementByCss('#page')

        expect(await browser.elementByCss('h1').text()).toBe('Template 0')
      })

      // TODO-APP: disable failing test and investigate later
      ;(isDev ? it.skip : it)(
        'should render the template that is a server component and rerender on navigation',
        async () => {
          const browser = await next.browser('/template/servercomponent')
          // eslint-disable-next-line jest/no-standalone-expect
          expect(await browser.elementByCss('h1').text()).toStartWith(
            'Template'
          )

          const currentTime = await browser
            .elementByCss('#performance-now')
            .text()

          await browser.elementByCss('#link').click()
          await browser.waitForElementByCss('#other-page')

          // eslint-disable-next-line jest/no-standalone-expect
          expect(await browser.elementByCss('h1').text()).toStartWith(
            'Template'
          )

          // template should rerender on navigation even when it's a server component
          // eslint-disable-next-line jest/no-standalone-expect
          expect(await browser.elementByCss('#performance-now').text()).toBe(
            currentTime
          )

          await browser.elementByCss('#link').click()
          await browser.waitForElementByCss('#page')

          // eslint-disable-next-line jest/no-standalone-expect
          expect(await browser.elementByCss('#performance-now').text()).toBe(
            currentTime
          )
        }
      )
    })

    describe('error component', () => {
      it('should trigger error component when an error happens during rendering', async () => {
        const browser = await next.browser('/error/client-component')
        await browser.elementByCss('#error-trigger-button').click()

        if (isDev) {
          // TODO: investigate desired behavior here as it is currently
          // minimized by default
          // expect(await hasRedbox(browser, true)).toBe(true)
          // expect(await getRedboxHeader(browser)).toMatch(/this is a test/)
        } else {
          await browser
          expect(
            await browser
              .waitForElementByCss('#error-boundary-message')
              .elementByCss('#error-boundary-message')
              .text()
          ).toBe('An error occurred: this is a test')
        }
      })

      it('should trigger error component when an error happens during server components rendering', async () => {
        const browser = await next.browser('/error/server-component')

        if (isDev) {
          expect(
            await browser
              .waitForElementByCss('#error-boundary-message')
              .elementByCss('#error-boundary-message')
              .text()
          ).toBe('this is a test')
          expect(
            await browser.waitForElementByCss('#error-boundary-digest').text()
            // Digest of the error message should be stable.
          ).not.toBe('')
          // TODO-APP: ensure error overlay is shown for errors that happened before/during hydration
          // expect(await hasRedbox(browser, true)).toBe(true)
          // expect(await getRedboxHeader(browser)).toMatch(/this is a test/)
        } else {
          await browser
          expect(
            await browser.waitForElementByCss('#error-boundary-message').text()
          ).toBe(
            'An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details. A digest property is included on this error instance which may provide additional details about the nature of the error.'
          )
          expect(
            await browser.waitForElementByCss('#error-boundary-digest').text()
            // Digest of the error message should be stable.
          ).not.toBe('')
        }
      })

      it('should use default error boundary for prod and overlay for dev when no error component specified', async () => {
        const browser = await next.browser(
          '/error/global-error-boundary/client'
        )
        await browser.elementByCss('#error-trigger-button').click()

        if (isDev) {
          expect(await hasRedbox(browser, true)).toBe(true)
          expect(await getRedboxHeader(browser)).toMatch(/this is a test/)
        } else {
          expect(
            await browser.waitForElementByCss('body').elementByCss('h2').text()
          ).toBe(
            'Application error: a client-side exception has occurred (see the browser console for more information).'
          )
        }
      })

      it('should display error digest for error in server component with default error boundary', async () => {
        const browser = await next.browser(
          '/error/global-error-boundary/server'
        )

        if (isDev) {
          expect(await hasRedbox(browser, true)).toBe(true)
          expect(await getRedboxHeader(browser)).toMatch(/custom server error/)
        } else {
          expect(
            await browser.waitForElementByCss('body').elementByCss('h2').text()
          ).toBe(
            'Application error: a client-side exception has occurred (see the browser console for more information).'
          )
          expect(
            await browser.waitForElementByCss('body').elementByCss('p').text()
          ).toMatch(/Digest: \w+/)
        }
      })

      if (!isDev) {
        it('should allow resetting error boundary', async () => {
          const browser = await next.browser('/error/client-component')

          // Try triggering and resetting a few times in a row
          for (let i = 0; i < 5; i++) {
            await browser
              .elementByCss('#error-trigger-button')
              .click()
              .waitForElementByCss('#error-boundary-message')

            expect(
              await browser.elementByCss('#error-boundary-message').text()
            ).toBe('An error occurred: this is a test')

            await browser
              .elementByCss('#reset')
              .click()
              .waitForElementByCss('#error-trigger-button')

            expect(
              await browser.elementByCss('#error-trigger-button').text()
            ).toBe('Trigger Error!')
          }
        })

        it('should hydrate empty shell to handle server-side rendering errors', async () => {
          const browser = await next.browser(
            '/error/ssr-error-client-component'
          )
          const logs = await browser.log()
          const errors = logs
            .filter((x) => x.source === 'error')
            .map((x) => x.message)
            .join('\n')
          expect(errors).toInclude('Error during SSR')
        })
      }
    })

    describe('known bugs', () => {
      describe('should support React cache', () => {
        it('server component', async () => {
          const browser = await next.browser('/react-cache/server-component')
          const val1 = await browser.elementByCss('#value-1').text()
          const val2 = await browser.elementByCss('#value-2').text()
          expect(val1).toBe(val2)
        })

        it('server component client-navigation', async () => {
          const browser = await next.browser('/react-cache')

          await browser
            .elementByCss('#to-server-component')
            .click()
            .waitForElementByCss('#value-1', 10000)
          const val1 = await browser.elementByCss('#value-1').text()
          const val2 = await browser.elementByCss('#value-2').text()
          expect(val1).toBe(val2)
        })

        it('client component', async () => {
          const browser = await next.browser('/react-cache/client-component')
          const val1 = await browser.elementByCss('#value-1').text()
          const val2 = await browser.elementByCss('#value-2').text()
          expect(val1).toBe(val2)
        })

        it('client component client-navigation', async () => {
          const browser = await next.browser('/react-cache')

          await browser
            .elementByCss('#to-client-component')
            .click()
            .waitForElementByCss('#value-1', 10000)
          const val1 = await browser.elementByCss('#value-1').text()
          const val2 = await browser.elementByCss('#value-2').text()
          expect(val1).toBe(val2)
        })
      })

      describe('should support React fetch instrumentation', () => {
        it('server component', async () => {
          const browser = await next.browser('/react-fetch/server-component')
          const val1 = await browser.elementByCss('#value-1').text()
          const val2 = await browser.elementByCss('#value-2').text()

          // TODO: enable when fetch cache is enabled in dev
          if (!isDev) {
            expect(val1).toBe(val2)
          }
        })

        it('server component client-navigation', async () => {
          const browser = await next.browser('/react-fetch')

          await browser
            .elementByCss('#to-server-component')
            .click()
            .waitForElementByCss('#value-1', 10000)
          const val1 = await browser.elementByCss('#value-1').text()
          const val2 = await browser.elementByCss('#value-2').text()

          // TODO: enable when fetch cache is enabled in dev
          if (!isDev) {
            expect(val1).toBe(val2)
          }
        })

        // TODO-APP: React doesn't have fetch deduping for client components yet.
        it.skip('client component', async () => {
          const browser = await next.browser('/react-fetch/client-component')
          const val1 = await browser.elementByCss('#value-1').text()
          const val2 = await browser.elementByCss('#value-2').text()
          expect(val1).toBe(val2)
        })

        // TODO-APP: React doesn't have fetch deduping for client components yet.
        it.skip('client component client-navigation', async () => {
          const browser = await next.browser('/react-fetch')

          await browser
            .elementByCss('#to-client-component')
            .click()
            .waitForElementByCss('#value-1', 10000)
          const val1 = await browser.elementByCss('#value-1').text()
          const val2 = await browser.elementByCss('#value-2').text()
          expect(val1).toBe(val2)
        })
      })
      it('should not share flight data between requests', async () => {
        const fetches = await Promise.all(
          [...new Array(5)].map(() => next.render('/loading-bug/electronics'))
        )

        for (const text of fetches) {
          const $ = cheerio.load(text)
          expect($('#category-id').text()).toBe('electronicsabc')
        }
      })
      it('should handle router.refresh without resetting state', async () => {
        const browser = await next.browser(
          '/navigation/refresh/navigate-then-refresh-bug'
        )
        await browser
          .elementByCss('#to-route')
          // Navigate to the page
          .click()
          // Wait for new page to be loaded
          .waitForElementByCss('#refresh-page')
          // Click the refresh button to trigger a refresh
          .click()

        // Wait for element that is shown when refreshed and verify text
        expect(await browser.waitForElementByCss('#refreshed').text()).toBe(
          'Refreshed page successfully!'
        )

        expect(
          await browser.eval(
            `window.getComputedStyle(document.querySelector('h1')).backgroundColor`
          )
        ).toBe('rgb(34, 139, 34)')
      })
      it('should handle as on next/link', async () => {
        const browser = await next.browser('/link-with-as')
        expect(
          await browser
            .elementByCss('#link-to-info-123')
            .click()
            .waitForElementByCss('#message')
            .text()
        ).toBe(`hello from app/dashboard/deployments/info/[id]. ID is: 123`)
      })
      it('should handle next/link back to initially loaded page', async () => {
        const browser = await next.browser('/linking/about')
        expect(
          await browser
            .elementByCss('a[href="/linking"]')
            .click()
            .waitForElementByCss('#home-page')
            .text()
        ).toBe(`Home page`)

        expect(
          await browser
            .elementByCss('a[href="/linking/about"]')
            .click()
            .waitForElementByCss('#about-page')
            .text()
        ).toBe(`About page`)
      })
      it('should not do additional pushState when already on the page', async () => {
        const browser = await next.browser('/linking/about')
        const goToLinkingPage = async () => {
          expect(
            await browser
              .elementByCss('a[href="/linking"]')
              .click()
              .waitForElementByCss('#home-page')
              .text()
          ).toBe(`Home page`)
        }

        await goToLinkingPage()
        await waitFor(1000)
        await goToLinkingPage()
        await waitFor(1000)
        await goToLinkingPage()
        await waitFor(1000)

        expect(
          await browser.back().waitForElementByCss('#about-page', 2000).text()
        ).toBe(`About page`)
      })
    })

    describe('next/script', () => {
      if (!isNextDeploy) {
        it('should support next/script and render in correct order', async () => {
          const browser = await next.browser('/script')

          // Wait for lazyOnload scripts to be ready.
          await new Promise((resolve) => setTimeout(resolve, 1000))

          expect(await browser.eval(`window._script_order`)).toStrictEqual([
            1,
            1.5,
            2,
            2.5,
            'render',
            3,
            4,
          ])
        })
      }

      it('should insert preload tags for beforeInteractive and afterInteractive scripts', async () => {
        const html = await next.render('/script')
        expect(html).toContain(
          '<link href="/test1.js" rel="preload" as="script"/>'
        )
        expect(html).toContain(
          '<link href="/test2.js" rel="preload" as="script"/>'
        )
        expect(html).toContain(
          '<link href="/test3.js" rel="preload" as="script"/>'
        )

        // test4.js has lazyOnload which doesn't need to be preloaded
        expect(html).not.toContain(
          '<script src="/test4.js" rel="preload" as="script"/>'
        )
      })
    })

    describe('data fetch with response over 16KB with chunked encoding', () => {
      it('should load page when fetching a large amount of data', async () => {
        const browser = await next.browser('/very-large-data-fetch')
        expect(await (await browser.waitForElementByCss('#done')).text()).toBe(
          'Hello world'
        )
        expect(await browser.elementByCss('p').text()).toBe('item count 128000')
      })
    })
  }
)
