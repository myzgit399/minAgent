import socket

_real_getaddrinfo = socket.getaddrinfo
_DNS_OVERRIDES = {
    "raw.githubusercontent.com": "185.199.108.133",
}


def _getaddrinfo(host, port, *args, **kwargs):
    if host in _DNS_OVERRIDES:
        host = _DNS_OVERRIDES[host]
    return _real_getaddrinfo(host, port, *args, **kwargs)


socket.getaddrinfo = _getaddrinfo
