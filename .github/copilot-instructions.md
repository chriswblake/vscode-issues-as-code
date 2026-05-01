## Formatting and Commenting

Put functions with several inputs on separate lines.
Place a `//` after the first input to prevent prettier from collapsing to one line.

Comments are used to identify logical chunks for quick navigation. They do not explain the code.

Use descriptive variable and function names. Avoid abbreviations unless they are widely understood.

When finishing a task, ensure formatting is consistent, organized, and readable by someone new to the project. Refactor to improve readability and maintainability.

When finishing a task, run prettier. `npx prettier --write .`

Organize methods in a file into groups to make them easy to find.

## Architecture

Each sync target is implemented as a plugin. Do not directly code them into the sync manager or core logic.

When writing functions, aim for a single responsibility.
If a function is doing too much, break it into smaller functions.

When finishing a task, compare the new changes to the existing codebase. Refactor the new or existing code to simplify and reduce complexity.

Use intuitive names for variables, functions, etc.

Do not worry about supporting previous versions of the code. Refactor and simplify as needed. There have been no releases yet.

## Testing

All unit tests must be independent.

Organize tests into Arrange, Act, Assert sections for clarity.
The description starts with the method being checked and a description of the unique test.
You can use an internal note for further explanation if needed.
Example:

```js
function add(a, b) {
  return a + b;
}
test('add: 2 positive integers', () => {
  // Verifies that basic math operations work as expected.

  // Arrange
  const a = 2;
  const b = 3;

  // Act
  const result = add(a, b);

  // Assert
  assert.strictEqual(result, 5);
});
```

Write tests alongside the code, not afterward. Tests ensure the interfaces remain intuitive and the methods' scope remains small.

## Changelog

Work in logical commits. Each commit should represent a single change or feature.
This makes it easier to review and understand the history of changes for creating the changelog.

Add a "pending" section to the changelong for each PR. This will be used for for publishing releases.
