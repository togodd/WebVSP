# Save XML completion event queue prototype

This is a standalone C++17 in-memory queue for possible future observation of
GUI Save XML completions. It is **not connected** to the GUI, engine, protocol,
or build. It neither observes saves nor performs file I/O. An `ok` value is
only the value supplied by the producer; it says nothing about browser-side
persistence. There is no serialization or persistence in this prototype.

`SaveXmlEventQueue<Capacity, MaxPathBytes>` stores a fixed number of events in
an inline array. Paths are copied as bytes, with a fixed maximum length and no
required encoding or terminating NUL. The queue does not allocate memory per
push or pop; stack/heap placement of the queue object is the caller's choice.
Construction of an impractically large object can exhaust available memory, and
mutex operations may throw `std::system_error` on platform failures. The input
path must remain valid and unchanged during a push. The caller must keep the
queue alive until all concurrent operations have completed.

`try_push` reports `accepted`, `full`, or `path_too_long`. When both limits
apply, `path_too_long` takes precedence. Rejected events are not queued and
accepted events are never overwritten. `rejections()` returns independent,
cumulative counters for the two rejection reasons; they saturate at
`UINT64_MAX`, after which they cannot indicate additional rejections. A new
queue starts a new count; there is no globally unique epoch. All operations
use a mutex, so they are thread-safe but not wait-free or lock-free. Accepted
items are popped FIFO in mutex acquisition order; an empty pop leaves its
output unchanged. Destruction discards any remaining events. In particular,
this is not a lossless event delivery mechanism: callers must handle rejection
and any other interruption themselves.

Native test from the repository root (requires a C++17 compiler and threads):

```sh
g++ -std=c++17 -Wall -Wextra -Wpedantic -Werror -pthread \
  web/wasm/engine/save_xml_event_queue_test.cpp -o /tmp/save-xml-event-queue-test
/tmp/save-xml-event-queue-test
```

The tests cover byte boundaries, rejection reporting, empty-pop preservation,
independent popped copies, FIFO and wraparound, plus concurrent producers and
both single and multiple consumers. They do not prove correctness for all
thread interleavings.
