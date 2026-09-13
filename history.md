# jsonstor-mssql
[`@liquicode/jsonstor-mssql`](https://github.com/liquicode/jsonstor-mssql)


# Project History


v0.2.0 (current)
---------------------------------------------------------------------

***First release.***

The adapter for Microsoft SQL Server, holding one connection pool. Tested on SQL Server 2017,
  2019 and 2022.

- Built on `@liquicode/jsonstor` 0.2.0 and `@liquicode/jsongin` 0.2.0. A criteria the engine
  refuses is refused before the storage acts on it.
- A `null` criteria matches every row, and `InsertMany` refuses a value which is not an array.
- Declares Node.js `>=18.0.0` in `engines`.
