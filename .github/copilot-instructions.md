## Formatting and Commenting

Always run formatting and linting before committing.

Put functions with several inputs on separate lines.
Place a `//` after the first input to prevent prettier from collapsing to one line.

Comments are used to identify logical chunks for quick navigation. They do not explain the code.
Use descriptive variable and function names. Avoid abbreviations unless they are widely understood.

## Architecture

When writing functions, aim for a single responsibility.
If a function is doing too much, break it into smaller functions.

## Testing

All unit tests must be independent.
Organize tests into Arrange, Act, Assert sections for clarity. Label the sections with a comment.

Write tests alongside the code, not afterward. Tests ensure the interfaces remain intuitive and the methods' scope remains small.

## Changelog

Work in logical commits. Each commit should represent a single change or feature.
This makes it easier to review and understand the history of changes for creating the changelog.

Add a "pending" section to the changelong for each PR. This will be used for for publishing releases.
