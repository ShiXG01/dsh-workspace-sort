'use strict'

/**
 * A minimal DOM implementation for the browser half's structural tests.
 *
 * Node ships no DOM and this project cannot depend on jsdom, but the
 * view-options injection is the highest-risk piece of the plan (the sidebar
 * exposes no slot for it), so it must be verifiable rather than trusted. This
 * implements exactly the surface `lib/client.src.js` touches — element tree,
 * class list, attributes, deep clone, fragment insertion and a small selector
 * engine — and nothing else.
 *
 * Deliberately absent: event dispatch, layout and text metrics. `cloneNode`
 * copies no listeners, matching the real DOM behaviour the injection relies
 * on.
 */

/**
 * Attribute selectors, including the two-character operators (`*=`, `^=`) the
 * plugin's lookups rely on. A single-character operator class would split
 * `class*="x"` into the name `class` plus the value `="x"`, which silently
 * matches nothing.
 */
const ATTRIBUTE_PATTERN = /\[([^\]=*^$~|]+)(?:([*^$~|]?=)(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g

/**
 * Parse the selector subset this project uses: `tag`, `[attr]`, `[attr="v"]`,
 * `[attr*="v"]` and `[attr^="v"]`, in any combination.
 * @param selector - the selector text.
 * @returns the parsed selector.
 */
function parseSelector(selector) {
  const text = String(selector).trim()
  const parts = /^([a-zA-Z#]*)((?:\[[^\]]*\])*)$/.exec(text)
  if (parts === null) throw new Error(`test-dom: unsupported selector "${selector}"`)
  const attributes = []
  ATTRIBUTE_PATTERN.lastIndex = 0
  let match
  while ((match = ATTRIBUTE_PATTERN.exec(parts[2])) !== null) {
    const rawOperator = match[2]
    attributes.push({
      name: match[1],
      op: rawOperator === undefined ? undefined : rawOperator === '=' ? '=' : rawOperator[0],
      value: match[3] ?? match[4] ?? match[5],
    })
  }
  return { tag: parts[1] === '' ? undefined : parts[1].toUpperCase(), attributes }
}

/** One DOM element. */
class Element {
  /** @param tagName - the element's tag name. */
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase()
    this.attributes = new Map()
    this.childNodes = []
    this.parentElement = null
    this.text = ''
    /** Registered listeners, by event type; `cloneNode` never copies these. */
    this.listeners = new Map()
    /** A plain style bag: this fake DOM has no layout to derive values from. */
    this.style = {}
  }

  /**
   * Register one listener.
   * @param type - event type.
   * @param listener - the callback.
   */
  addEventListener(type, listener) {
    const existing = this.listeners.get(type)
    if (existing === undefined) this.listeners.set(type, [listener])
    else existing.push(listener)
  }

  /**
   * Remove one listener.
   * @param type - event type.
   * @param listener - the callback.
   */
  removeEventListener(type, listener) {
    const existing = this.listeners.get(type)
    if (existing === undefined) return
    this.listeners.set(
      type,
      existing.filter((candidate) => candidate !== listener),
    )
  }

  /**
   * A fixed box, since this fake DOM performs no layout.
   * @returns a plausible element rect.
   */
  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 180, bottom: 80, width: 180, height: 80 }
  }

  /** Element children only, as a plain array. */
  get children() {
    return this.childNodes.filter((node) => node instanceof Element)
  }

  /** The last element child, or null. */
  get lastElementChild() {
    const children = this.children
    return children.length === 0 ? null : children[children.length - 1]
  }

  /** The first element child, or null. */
  get firstElementChild() {
    const children = this.children
    return children.length === 0 ? null : children[0]
  }

  /** The element immediately before this one, or null. */
  get previousElementSibling() {
    if (this.parentElement === null) return null
    const siblings = this.parentElement.children
    const index = siblings.indexOf(this)
    return index <= 0 ? null : siblings[index - 1]
  }

  /** The element immediately after this one, or null. */
  get nextElementSibling() {
    if (this.parentElement === null) return null
    const siblings = this.parentElement.children
    const index = siblings.indexOf(this)
    return index === -1 || index === siblings.length - 1 ? null : siblings[index + 1]
  }

  /** The class attribute, kept as a normalized string. */
  get className() {
    return this.attributes.get('class') ?? ''
  }

  set className(value) {
    this.attributes.set('class', String(value))
  }

  /** The class list, with the operations the injection uses. */
  get classList() {
    const owner = this
    const read = () => (owner.className === '' ? [] : owner.className.split(/\s+/).filter(Boolean))
    const write = (names) => {
      owner.className = names.join(' ')
    }
    return {
      add(name) {
        const names = read()
        if (!names.includes(name)) names.push(name)
        write(names)
      },
      remove(name) {
        write(read().filter((candidate) => candidate !== name))
      },
      contains(name) {
        return read().includes(name)
      },
      get length() {
        return read().length
      },
      [Symbol.iterator]() {
        return read()[Symbol.iterator]()
      },
    }
  }

  /** Concatenated text of this subtree. */
  get textContent() {
    if (this.text !== '') return this.text
    return this.children.map((child) => child.textContent).join('')
  }

  set textContent(value) {
    this.childNodes = []
    this.text = value === undefined || value === null ? '' : String(value)
  }

  /** @param name - attribute name. @returns the value, or null. */
  getAttribute(name) {
    const value = this.attributes.get(name)
    return value === undefined ? null : value
  }

  /** @param name - attribute name. @param value - attribute value. */
  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  /** @param name - attribute name. */
  removeAttribute(name) {
    this.attributes.delete(name)
  }

  /** @param name - attribute name. @returns whether it is present. */
  hasAttribute(name) {
    return this.attributes.has(name)
  }

  /**
   * Append one node, splicing a fragment's children.
   * @param node - the node to append.
   * @returns the appended node.
   */
  appendChild(node) {
    return this.insertBefore(node, null)
  }

  /**
   * Insert one node before an anchor, splicing a fragment's children.
   * @param node - the node to insert.
   * @param anchor - the following sibling, or null to append.
   * @returns the inserted node.
   */
  insertBefore(node, anchor) {
    if (node.tagName === '#FRAGMENT') {
      for (const child of [...node.childNodes]) this.insertBefore(child, anchor)
      node.childNodes = []
      return node
    }
    if (node.parentElement !== null) node.remove()
    const at = anchor === null ? -1 : this.childNodes.indexOf(anchor)
    if (at === -1) this.childNodes.push(node)
    else this.childNodes.splice(at, 0, node)
    node.parentElement = this
    return node
  }

  /** Detach this node from its parent. */
  remove() {
    if (this.parentElement === null) return
    const at = this.parentElement.childNodes.indexOf(this)
    if (at !== -1) this.parentElement.childNodes.splice(at, 1)
    this.parentElement = null
  }

  /**
   * Deep or shallow clone. Listeners are never copied, as in a real DOM.
   * @param deep - whether to clone descendants.
   * @returns the clone.
   */
  cloneNode(deep) {
    const clone = new Element(this.tagName)
    for (const [name, value] of this.attributes) clone.attributes.set(name, value)
    clone.text = this.text
    if (deep === true) for (const child of this.childNodes) clone.appendChild(child.cloneNode(true))
    return clone
  }

  /** @param selector - selector text. @returns whether this element matches. */
  matches(selector) {
    const parsed = parseSelector(selector)
    if (parsed.tag !== undefined && this.tagName !== parsed.tag) return false
    for (const { name, op, value } of parsed.attributes) {
      const actual = this.getAttribute(name)
      if (actual === null) return false
      if (op === undefined) continue
      if (op === '=' && actual !== value) return false
      if (op === '*' && !actual.includes(value)) return false
      if (op === '^' && !actual.startsWith(value)) return false
    }
    return true
  }

  /** @param selector - selector text. @returns every matching descendant. */
  querySelectorAll(selector) {
    const found = []
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child)
        walk(child)
      }
    }
    walk(this)
    return found
  }

  /** @param selector - selector text. @returns the first match, or null. */
  querySelector(selector) {
    const all = this.querySelectorAll(selector)
    return all.length === 0 ? null : all[0]
  }

  /** @param selector - selector text. @returns the nearest matching ancestor-or-self. */
  closest(selector) {
    let node = this
    while (node !== null) {
      if (node.matches(selector)) return node
      node = node.parentElement
    }
    return null
  }
}

/**
 * Build one detached element.
 * @param tagName - the tag name.
 * @returns the element.
 */
function createElement(tagName) {
  return new Element(tagName)
}

/**
 * Create a test document with the given body children.
 * @param children - body children to install.
 * @returns the document.
 */
function createDocument(children = []) {
  const head = new Element('head')
  const body = new Element('body')
  for (const child of children) body.appendChild(child)
  const dispatched = []
  const roots = () => [head, body]
  return {
    head,
    body,
    dispatched,
    createElement,
    createElementNS: (_namespace, tagName) => new Element(tagName),
    createDocumentFragment: () => new Element('#fragment'),
    querySelector: (selector) => {
      for (const root of roots()) {
        const found = root.querySelector(selector)
        if (found !== null) return found
      }
      return null
    },
    querySelectorAll: (selector) => roots().flatMap((root) => root.querySelectorAll(selector)),
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: (event) => {
      dispatched.push(event)
      return true
    },
  }
}

/**
 * Build one element from a compact description.
 * @param tagName - tag name.
 * @param options - className, attributes and children.
 * @returns the element.
 */
function el(tagName, options = {}) {
  const node = new Element(tagName)
  if (options.className !== undefined) node.className = options.className
  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    node.setAttribute(name, value)
  }
  if (options.text !== undefined) node.textContent = options.text
  for (const child of options.children ?? []) node.appendChild(child)
  return node
}

module.exports = { Element, createDocument, createElement, el, parseSelector }
