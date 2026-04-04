# Project Guidance

- Keep display-only derivation close to the component that renders it.
- Pass raw state down when possible, not preformatted UI strings from `App`.
- Prefer CSS structure/nesting over one-off helper classes when the element is local and obvious.
- Prefer a small number of stable structural classes on meaningful subtrees over brittle selectors that depend on anonymous wrappers or element position.
- Do not add classes to every child by default. Start with the component root plus nested selectors, then add a class only where it gives the CSS a stable, readable hook.
- Avoid selectors like `> div > div`, `:first-child`, or `:last-child` when they are standing in for actual structure. If a subtree needs styling or interaction state, give that subtree a clear class.
- When styling component internals, favor nested CSS under the component root class and reserve extra classes for repeated row/action/layout primitives such as `tree-row` or `tree-actions`.
