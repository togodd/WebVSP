#!/usr/bin/env python3
"""Compile and exercise the actual engine queue-turn implementation with a fake clock.

Run from any directory: python3 web/wasm/tests/queue_turn_test.py
Requires a C++11 compiler. This is not a browser/FLTK integration test.
"""
from pathlib import Path
import subprocess
import tempfile

engine = (Path(__file__).resolve().parents[1] / 'engine' / 'engine.cpp').read_text()
start = engine.index('// BEGIN queue turn implementation')
end = engine.index('// END queue turn implementation', start)
implementation = engine[start:end]
harness = r'''
#include <cassert>
#include <chrono>
#include <deque>
#include <mutex>
#include <utility>
#include <vector>
struct Job { int id = 0; };
std::mutex g_Mutex;
std::deque<Job> g_Jobs;
std::vector<int> done;
struct Clock {
    using time_point = std::chrono::steady_clock::time_point;
    static time_point time;
    static time_point now() { return time; }
};
Clock::time_point Clock::time{};
int duration_ms = 0;
bool produce = false;
void Run(Job &j) {
    done.push_back(j.id);
    Clock::time += std::chrono::milliseconds(duration_ms);
    if (produce) { std::lock_guard<std::mutex> lock(g_Mutex); g_Jobs.push_back({j.id + 1000}); }
}
''' + implementation + r'''
int main() {
    // Continuous production: bounded turn, FIFO and no discarded tail.
    for (int i = 0; i < 40; ++i) g_Jobs.push_back({i});
    produce = true;
    DrainJobTurn<Clock>();
    assert(done.size() == 32 && g_Jobs.size() == 40);
    for (int i = 0; i < 32; ++i) assert(done[i] == i);
    produce = false;
    while (!g_Jobs.empty()) DrainJobTurn<Clock>();
    assert(done.size() == 72);
    for (int i = 0; i < 40; ++i) assert(done[i] == i);
    for (int i = 0; i < 32; ++i) assert(done[40+i] == 1000+i);
    // Time expires only after a whole job, leaving the rest for the next turn.
    done.clear(); duration_ms = 5;
    for (int i = 0; i < 5; ++i) g_Jobs.push_back({i});
    DrainJobTurn<Clock>();
    assert(done.size() == 2 && g_Jobs.size() == 3);
    DrainJobTurn<Clock>(); DrainJobTurn<Clock>();
    assert(done.size() == 5 && g_Jobs.empty());
    for (int i = 0; i < 5; ++i) assert(done[i] == i);
    // One slow job is not interrupted; subsequent jobs stay queued.
    done.clear(); duration_ms = 100;
    g_Jobs.push_back({1}); g_Jobs.push_back({2});
    DrainJobTurn<Clock>();
    assert(done.size() == 1 && done[0] == 1 && g_Jobs.size() == 1);
    DrainJobTurn<Clock>();
    assert(done.size() == 2 && done[1] == 2 && g_Jobs.empty());
}
'''
with tempfile.TemporaryDirectory() as directory:
    source = Path(directory) / 'test.cpp'
    binary = Path(directory) / 'test'
    source.write_text(harness)
    subprocess.run(['c++', '-std=c++14', '-pthread', str(source), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
print('queue turn tests passed')
