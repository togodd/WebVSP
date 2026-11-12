#ifndef WEBVSP_SAVE_XML_EVENT_QUEUE_H
#define WEBVSP_SAVE_XML_EVENT_QUEUE_H

#include <array>
#include <cstddef>
#include <cstring>
#include <mutex>
#include <limits>
#include <cstdint>
#include <string_view>

namespace webvsp
{

// Standalone, in-memory prototype. No connection to GUI saves or file I/O.
// Capacity and maximum path length are compile-time byte limits; a rejected
// push never changes the queue. Paths are byte strings, not necessarily UTF-8
// or NUL-terminated, and may contain embedded NULs.
template <std::size_t Capacity, std::size_t MaxPathBytes>
class SaveXmlEventQueue
{
    static_assert( Capacity > 0, "queue capacity must be positive" );

public:
    struct Event
    {
        std::array<char, MaxPathBytes> path{};
        std::size_t path_size = 0;
        bool ok = false;

        // The view remains valid only while this Event is alive and unchanged.
        std::string_view path_view() const noexcept
        {
            return path_size ? std::string_view( path.data(), path_size ) : std::string_view{};
        }
    };

    enum class PushResult { accepted, full, path_too_long };

    struct Rejections
    {
        std::uint64_t full = 0;
        std::uint64_t path_too_long = 0;
    };

    // Counters are cumulative for this queue's lifetime, independent of the
    // event slots; each saturates at UINT64_MAX rather than wrapping. They are
    // not reset on reads, so callers can compare snapshots until saturation.
    Rejections rejections() const
    {
        std::lock_guard<std::mutex> lock( mutex_ );
        return rejections_;
    }

    // The caller must keep path valid and unchanged for the duration of this call.
    // Oversize takes precedence over full. No events are overwritten on overflow.
    PushResult try_push( std::string_view path, bool ok )
    {
        std::lock_guard<std::mutex> lock( mutex_ );
        if ( path.size() > MaxPathBytes )
        {
            increment_saturating( rejections_.path_too_long );
            return PushResult::path_too_long;
        }
        if ( size_ == Capacity )
        {
            increment_saturating( rejections_.full );
            return PushResult::full;
        }
        Event& event = events_[tail_];
        if constexpr ( MaxPathBytes > 0 )
        {
            if ( !path.empty() )
            {
                std::memcpy( event.path.data(), path.data(), path.size() );
            }
        }
        event.path_size = path.size();
        event.ok = ok;
        tail_ = ( tail_ + 1 ) % Capacity;
        ++size_;
        return PushResult::accepted;
    }

    // Returns false without modifying out when empty. Accepted events are
    // removed in FIFO order, as ordered by the queue's mutex.
    bool try_pop( Event& out )
    {
        std::lock_guard<std::mutex> lock( mutex_ );
        if ( size_ == 0 )
        {
            return false;
        }
        out = events_[head_];
        head_ = ( head_ + 1 ) % Capacity;
        --size_;
        return true;
    }

private:
    static void increment_saturating( std::uint64_t& counter ) noexcept
    {
        if ( counter != std::numeric_limits<std::uint64_t>::max() ) ++counter;
    }

    mutable std::mutex mutex_;
    Rejections rejections_{};
    std::array<Event, Capacity> events_{};
    std::size_t head_ = 0;
    std::size_t tail_ = 0;
    std::size_t size_ = 0;
};

} // namespace webvsp

#endif
