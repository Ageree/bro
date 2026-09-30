#!/bin/bash
# Is hardware virtualization available inside a Cloud.ru VM? (nested KVM, 29.09.2026: yes on gen-2-4, ru.AZ-3)
systemd-detect-virt
grep -m1 'model name' /proc/cpuinfo
grep -o -w -E 'vmx|svm|ept|vpid' /proc/cpuinfo | sort | uniq -c
modprobe kvm_intel 2>/dev/null || modprobe kvm_amd 2>/dev/null
ls -l /dev/kvm
echo "nested=$(cat /sys/module/kvm_intel/parameters/nested 2>/dev/null || cat /sys/module/kvm_amd/parameters/nested 2>/dev/null)"
