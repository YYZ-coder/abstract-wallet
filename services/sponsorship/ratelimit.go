package sponsorship

import "net"

type rateBucket struct {
	Minute int64
	Count  int
}

func (s *server) allowRequest(remote string) bool {
	host, _, e := net.SplitHostPort(remote)
	if e != nil {
		host = remote
	}
	minute := s.c.Clock().Unix() / 60
	s.rateMu.Lock()
	defer s.rateMu.Unlock()
	b := s.rateBuckets[host]
	if b.Minute != minute {
		b = rateBucket{Minute: minute}
	}
	if b.Count >= s.c.RequestsPerMinute {
		return false
	}
	b.Count++
	s.rateBuckets[host] = b
	if len(s.rateBuckets) > 10000 {
		for k, v := range s.rateBuckets {
			if v.Minute != minute {
				delete(s.rateBuckets, k)
			}
		}
	}
	return true
}
