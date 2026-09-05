One JSON record per benchmark run, written by `bun run bench --save`.

Committed rather than ignored, because the point of the file is the history:
regression budgets have to be set from how much these numbers move across
machines and CI runs when nothing is wrong, and that is only visible in a series.
A run recorded on a laptop under load is still evidence — of how noisy a laptop
under load is — so nothing here is pruned for being unflattering.

See [Performance baselines](../../docs/performance.md).
