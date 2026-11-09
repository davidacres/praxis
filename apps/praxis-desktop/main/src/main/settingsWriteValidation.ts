import { normalizeMobileSubnet, type AppSettingsPatch } from '@praxis/core';

/** Reject invalid user input before the settings sanitizer can discard it. */
export function validateSettingsPatch(patch: AppSettingsPatch): void {
  if (patch.mobileAccess?.allowedSubnets?.some(value => normalizeMobileSubnet(value) === undefined)) {
    throw new Error('Allowed mobile subnets must be IP addresses or CIDRs, for example 192.168.1.0/24.');
  }
}
