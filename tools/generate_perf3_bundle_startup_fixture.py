"""Independent Python reference oracle for Perf-3 pure decision functions."""

import json
import pathlib


CONSTRAINED_EFFECTIVE_TYPES = frozenset({'slow-2g', '2g'})
STALE_CHUNK_PATTERNS = (
    'failed to fetch dynamically imported module',
    'importing a module script failed',
    'error loading dynamically imported module',
    'mime type',
    'chunkloaderror',
)


def evaluate_prefetch_decision_py(trigger: str, env: dict) -> str:
    if env['alreadyLoadedOrLoading']:
        return 'SKIP_ALREADY_READY'
    if (not env['online']) or (not env['visible']):
        return 'BLOCK_ENVIRONMENT'

    raw_eff = env['effectiveType']
    eff = raw_eff.strip().lower() if isinstance(raw_eff, str) else ''
    constrained = eff in CONSTRAINED_EFFECTIVE_TYPES
    save_data = bool(env['saveData'])

    if trigger == 'idle':
        if constrained or save_data:
            return 'BLOCK_ENVIRONMENT'
        ms_long = env['msSinceLastLongTask']
        idle_rem = env['idleTimeRemainingMs']
        if (ms_long is not None and ms_long < 1000) or (idle_rem is not None and idle_rem < 15):
            return 'DEFER_MAIN_THREAD_BUSY'
    else:
        if constrained and save_data:
            return 'BLOCK_ENVIRONMENT'

    if env['inFlightCount'] >= env['maxConcurrent']:
        return 'DEFER_CONCURRENCY'

    return 'ALLOW'


def classify_chunk_failure_py(inp: dict) -> str:
    if (not inp['online']) or (not inp['backendReachable']):
        return 'TRANSIENT_NETWORK'
    msg = str(inp['errorMessage']).lower()
    is_chunk_sig = any(pat in msg for pat in STALE_CHUNK_PATTERNS)
    if is_chunk_sig and inp['failureCountForModule'] >= 2:
        return 'STALE_DEPLOYMENT_CHUNK'
    return 'TRANSIENT_NETWORK'


def main() -> None:
    prefetch_cases = []
    triggers = ('intent', 'idle')
    bools = (False, True)
    eff_types = (None, '4g', '3g', '2g', 'slow-2g', '2G')
    in_flights = (0, 1, 2)
    long_tasks = (None, 250, 999, 1000, 2500)
    idle_rems = (None, 5, 14.9, 15, 45)

    for trigger in triggers:
        for already in bools:
            for online in bools:
                for visible in bools:
                    for save_data in bools:
                        for eff in eff_types:
                            for in_flight in in_flights:
                                # Pick representative main-thread boundaries
                                for ms_lt, idle_r in (
                                    (None, None),
                                    (500, 30),
                                    (999, 30),
                                    (1000, 14.5),
                                    (1000, 15),
                                    (1500, 25),
                                ):
                                    env = {
                                        'online': online,
                                        'visible': visible,
                                        'saveData': save_data,
                                        'effectiveType': eff,
                                        'inFlightCount': in_flight,
                                        'maxConcurrent': 1,
                                        'alreadyLoadedOrLoading': already,
                                        'msSinceLastLongTask': ms_lt,
                                        'idleTimeRemainingMs': idle_r,
                                    }
                                    prefetch_cases.append({
                                        'trigger': trigger,
                                        'env': env,
                                        'expected': evaluate_prefetch_decision_py(trigger, env),
                                    })

    # Deduplicate while preserving order so fixture stays crisp and comprehensive
    seen = set()
    unique_prefetch = []
    for item in prefetch_cases:
        key = json.dumps({'t': item['trigger'], 'e': item['env']}, sort_keys=True)
        if key not in seen:
            seen.add(key)
            unique_prefetch.append(item)

    failure_messages = (
        'Failed to fetch dynamically imported module: https://app/assets/mod-ggal-123.js',
        'Importing a module script failed.',
        'error loading dynamically imported module: mod-options.js',
        "Loading module was blocked because of a disallowed MIME type ('text/html')",
        'ChunkLoadError: Loading chunk mod-markets failed',
        'NetworkError when attempting to fetch resource',
        'TypeError: Failed to fetch',
        'Timeout awaiting module response',
    )
    failure_cases = []
    for msg in failure_messages:
        for online in (False, True):
            for reachable in (False, True):
                for count in (0, 1, 2, 3):
                    inp = {
                        'errorMessage': msg,
                        'online': online,
                        'failureCountForModule': count,
                        'backendReachable': reachable,
                    }
                    failure_cases.append({
                        'input': inp,
                        'expected': classify_chunk_failure_py(inp),
                    })

    root = pathlib.Path(__file__).resolve().parent.parent
    out_path = root / 'fixtures' / 'perf3_bundle_startup_reference.json'
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(
            {
                'schemaVersion': 1,
                'prefetchCases': unique_prefetch,
                'chunkFailureCases': failure_cases,
            },
            indent=2,
        )
        + '\n',
        encoding='utf-8',
    )
    print(f'Generated {len(unique_prefetch)} prefetchCases + {len(failure_cases)} chunkFailureCases -> {out_path}')


if __name__ == '__main__':
    main()
