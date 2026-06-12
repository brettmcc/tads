# Tad (Stata-command fork)

> **This fork** extends Tad with a Stata-like command bar and an
> append-only results pane: `bro[wse]`, `sum[marize]`, `tab[ulate]`,
> and `codebook`, each with an optional `if` filter expression, with
> the generated SQL visible for every command. See
> [doc/stata-commands.md](doc/stata-commands.md) for the command
> language and [Building this fork](#building-this-fork-windows) below.
> The DuckDB backend has been migrated from the legacy native `duckdb`
> module to [`@duckdb/node-api`](https://www.npmjs.com/package/@duckdb/node-api)
> (prebuilt NAPI bindings — no Visual Studio / node-gyp build step), and
> the monorepo now uses npm workspaces instead of Lerna bootstrap.

This repository contains the source code for [Tad](https://www.tadviewer.com), an application for viewing and analyzing tabular
data sets.

The Tad desktop application enables you to quickly view and explore tabular data in several of the most popular
tabular data file formats: CSV, Parquet, and SQLite and DuckDb database files.
Internally, the application is powered by an in-memory instance of [DuckDb](https://duckdb.org/), a fast, embeddable database engine optimized for analytic queries.

The core of Tad is a React UI component that implements a hierarchical pivot table that allows you to specify a combination of pivot, filter, aggregate, sort, column selection, column ordering and basic column formatting operations. Tad delegates to a SQL database for storage and analytics, and generates SQL queries to perform all
analytic operations specified in the UI.

Tad can be launched from the command line like this:

    $ tad MetObjects.csv

This will open a window with a scrollable view of the full contents of the CSV file:

![Tad screenshot](doc/screenshots/tad-metobjects-unpivoted.png "Unpivoted view of CSV file")

Tad uses [SlickGrid](http://slickgrid.net/) for rendering the data grid. This allows Tad to support efficient linear
scrolling of the entire file, even for very large (millions of rows) data sets.

A few additional mouse clicks on the above view yields this view, pivoted by a few
columns (`Department`, `Classification`, `Period` and `Culture`), sorted by the `Object Start Date` column, and
with columns re-ordered:

![tad screenshot](doc/screenshots/tad-metobjects-pivoted.png "Met Museum Objects with Pivots")

# Installing Tad

The easiest way to install the Tad desktop app is to use a pre-packaged binary release. See [The Tad Landing Page](http://tadviewer.com/#news) for information on the latest release and download links, or go straight to the [releases](./releases) page.

# History and What's Here

Tad was initially released in 2017 as a standalone desktop application for viewing and exploring CSV files.

The core of Tad is a React UI component that implements a hierarchical pivot table that allows you to specify a combination of pivot, filter, aggregate, sort, column selection, column ordering and basic column formatting operations. Tad delegates to a SQL database for storage and analytics, and generates SQL queries to perform all
analytic operations specified in the UI.

This repository is a modular refactor of the original Tad source code, with several key improvements on the original code base:

- The repository is organized as a modular [Lerna](https://lerna.js.org/) based monorepo.
- The code has been ported to TypeScript and the UI code has been updated to React Hooks.
- There is support for communicating with multiple database back ends for reltab (Tad's SQL generation and query evaluation layer), in addition to the original sqlite. Current backends (in varying degrees of completeness) include DuckDb, Snowflake, Google BigQuery, and AWS Athena (Presto)
- There is a minimal proof-of-concept web-based front-end to demonstrate how Tad can be deployed on the web.
- The core Tad pivot table component now builds in its own module independent of any front end. This should allow embedding the Tad pivot table in other applications or contexts.

## The Essential Packages

The core packages that are used to build Tad are found in the [packages](./packages) sub-directory. These are the packages
used to build the Tad desktop application:

- [**reltab**](./packages/reltab) - The core abstraction used in Tad for programmatically constructing and executing relational SQL queries. This also defines the driver interface implemented by specific database back-ends, and a small, transport-agnostic remoting layer to allow queries and results to be transmitted between a web browser
  (or electron renderer process) and a reltab backend server.
- [**reltab-duckdb**](./packages/reltab-duckdb/) -- reltab driver for DuckDb
- [**reltab-sqlite**](./packages/reltab-sqlite/) -- reltab driver for SQLite
- [**aggtree**](./packages/aggtree/) - A library built on top of reltab for constructing pivot trees from relational queries.
- [**tadviewer**](./packages/tadviewer/) - The core Tad pivot table UI as a standalone, embeddable React component.
- [**tad-app**](./packages/tad-app/) - The Tad desktop application, built with Electron

## Experimental Packages

Upstream Tad shipped several proof-of-concept packages (a web app and
server, plus AWS Athena, Google BigQuery, and Snowflake drivers). They
have been **removed from this fork** — it targets the desktop app and
DuckDB only, which also allowed the desktop IPC transport to drop its
JSON encoding in favor of Electron structured clone. See upstream
[antonycourtney/tad](https://github.com/antonycourtney/tad) if you need
them. (`reltab-sqlite` remains in the tree but outside the default
build.)

# Building this fork (Windows)

Requirements: **Node >= 24** (see `.nvmrc`) and npm >= 10. No Visual
Studio or Python toolchain is needed: every native dependency ships
prebuilt binaries.

```sh
npm install        # installs all workspace packages
npm run build      # builds reltab, aggtree, drivers, tadviewer, tad-app
npm start          # launches the desktop app (or: npm start -- file.parquet)
npm test           # reltab + reltab-duckdb + tadviewer test suites
npm run pack       # packaged app in packages/tad-app/dist/win-unpacked
npm run dist       # full distributable installer
```

End-to-end tests for the command bar (require a prior `npm run build`
or `build-dev`):

```sh
npm run test:e2e -w packages/tad-app          # dev-build Electron e2e
node packages/tad-app/tools/packagedSmoke.js  # packaged-app smoke test
```

The default workspace set deliberately excludes `reltab-sqlite` (its
legacy `sqlite3` dependency needs an old native toolchain), the
athena/snowflake drivers, and the web app/server; their sources remain
in `packages/` for reference.

# Building Tad from Source

Detailed instructions on building tad from sources available in [doc/building.md](doc/building.md)
