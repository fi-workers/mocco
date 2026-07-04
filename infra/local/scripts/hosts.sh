#!/bin/bash
# Local domains → 127.0.0.1 (requires sudo)
grep -q "127.0.0.1 host.docker.internal" /etc/hosts || echo "127.0.0.1 host.docker.internal" | sudo tee -a /etc/hosts
grep -q "127.0.0.1 mocco.work" /etc/hosts || echo "127.0.0.1 mocco.work" | sudo tee -a /etc/hosts
grep -q "127.0.0.1 www.mocco.work" /etc/hosts || echo "127.0.0.1 www.mocco.work" | sudo tee -a /etc/hosts
