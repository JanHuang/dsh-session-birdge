import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

test('the client bundle registers one named View after Trajectory', () => {
  let captured
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: registration => { captured = registration } } },
    console,
  })
  vm.runInContext(fs.readFileSync(path.join(root, 'client.js'), 'utf8'), context)
  assert.equal(captured.id, 'dsh-session-bridge')

  const react = {
    createElement: () => null,
    useCallback: callback => callback,
    useEffect: () => {},
    useRef: value => ({ current: value }),
    useState: value => [value, () => {}],
  }
  const plugin = captured.factory(specifier => {
    if (specifier === 'react') return react
    throw new Error(`unexpected require ${specifier}`)
  })
  assert.equal(plugin.name, 'session-bridge')
  assert.equal(plugin.inject.join(','), 'slots,locale,remote,remote.session')

  let dictionary
  let registration
  let injected
  const ctx = {
    effect: execute => {
      const cleanup = execute()
      return () => { if (typeof cleanup === 'function') cleanup() }
    },
    locale: {
      register: (namespace, dictionaries) => {
        dictionary = { namespace, dictionaries }
        return () => {}
      },
      bind: () => key => key,
    },
    slots: {
      inject: (name, callback) => {
        injected = name
        return callback()
      },
      register: (options, component) => {
        registration = { options, component }
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  assert.equal(injected, 'conversation.view')
  assert.equal(registration.options.name, 'conversation.view')
  assert.equal(registration.options.id, 'bridge')
  assert.equal(registration.options.order, 15)
  assert.equal(registration.options.locale, 'session-bridge')
  assert.equal(registration.options.label(), 'view.bridge')
  assert.equal(typeof registration.component, 'function')
  assert.equal(dictionary.namespace, 'session-bridge')
  assert.ok(dictionary.dictionaries.zh['view.bridge'])
  assert.ok(dictionary.dictionaries.en['view.bridge'])
})
