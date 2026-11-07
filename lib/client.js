/**
 * dsh-plan-mode — browser half.
 *
 * Hand-built client bundle for DSH's runtime module loader: it registers a
 * factory that the shell materialises lazily. React and the JSX runtime come
 * from the shell's shared module table, so no bundler is involved.
 *
 * The pill sits in the composer's right slot, next to the model selector, and
 * flips the host-side plan-mode switch over the plugin's own HTTP route.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plan-mode',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const jsx = require('react/jsx-runtime')

    const ROUTE = '/plugins/dsh-plan-mode/state'

    /** Shared, page-local mirror of the host switch. */
    const store = { enabled: false, ready: false, busy: false }
    const listeners = new Set()
    function emit() {
      for (const listener of listeners) listener()
    }

    async function readState() {
      try {
        const response = await fetch(ROUTE, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
        if (!response.ok) return
        const body = await response.json()
        store.enabled = body.enabled === true
        store.ready = true
        emit()
      } catch {
        /* host not reachable yet; keep the last known value */
      }
    }

    async function writeState(enabled) {
      store.enabled = enabled
      store.busy = true
      emit()
      try {
        const response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ enabled }),
        })
        if (response.ok) {
          const body = await response.json()
          store.enabled = body.enabled === true
        }
      } catch {
        store.enabled = !enabled
      } finally {
        store.busy = false
        emit()
      }
    }

    function PlanModeToggle() {
      const [, force] = react.useReducer((value) => value + 1, 0)

      react.useEffect(() => {
        listeners.add(force)
        if (!store.ready) readState()
        return () => {
          listeners.delete(force)
        }
      }, [])

      const on = store.enabled
      const title = on
        ? '规划模式：开。每轮第一个步骤前先用 Codex 模型产出执行大纲，再交给主模型执行。点击关闭。'
        : '规划模式：关。点击开启后，任务开始前会先用 Codex 模型产出一份执行大纲。'

      return jsx.jsx('button', {
        type: 'button',
        title,
        'aria-pressed': on,
        disabled: store.busy,
        onClick: () => {
          void writeState(!store.enabled)
        },
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          height: 26,
          padding: '0 9px',
          borderRadius: 999,
          border: `1px solid ${on ? 'rgba(77,107,254,0.85)' : 'rgba(127,127,127,0.35)'}`,
          background: on ? 'rgba(77,107,254,0.14)' : 'transparent',
          color: on ? 'rgb(96,124,255)' : 'inherit',
          font: 'inherit',
          fontSize: 12,
          lineHeight: 1,
          cursor: store.busy ? 'progress' : 'pointer',
          opacity: store.busy ? 0.6 : 1,
          whiteSpace: 'nowrap',
          transition: 'background 120ms ease, border-color 120ms ease, color 120ms ease',
        },
        children: [
          jsx.jsx('span', {
            key: 'dot',
            style: {
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: on ? 'rgb(96,124,255)' : 'currentColor',
              opacity: on ? 1 : 0.45,
            },
          }),
          jsx.jsx('span', { key: 'label', children: '规划' }),
        ],
      })
    }

    function apply(ctx) {
      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.right',
            id: 'plan-mode-toggle',
            order: 5,
            inject: () => ({}),
          },
          PlanModeToggle,
        ),
      )
    }

    exports.name = 'dsh-plan-mode-client'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
