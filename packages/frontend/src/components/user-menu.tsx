import { LogOutIcon, SettingsIcon } from 'lucide-react';
import Link from 'next/link';

import { Routes } from '@/lib/routes';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

interface Props {
  user: { name: string; email: string };
}

// Top-right account menu: shows who's signed in, links to settings and sign-out.
export default function UserMenu({ user }: Props) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Open account menu"
        className="flex size-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground transition hover:opacity-90 aria-expanded:ring-2 aria-expanded:ring-ring">
        {user.name.charAt(0).toUpperCase()}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-foreground">{user.name}</span>
            <span className="truncate text-xs font-normal text-muted-foreground">{user.email}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          nativeButton={false}
          render={
            <Link href={Routes.account}>
              <SettingsIcon />
              Account settings
            </Link>
          }
        />
        <DropdownMenuItem
          nativeButton={false}
          variant="destructive"
          render={
            <Link href={Routes.signOut}>
              <LogOutIcon />
              Sign out
            </Link>
          }
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
