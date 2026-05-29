'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Gem } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { getApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/shared/field';
import { Spinner } from '@/components/ui/spinner';

const schema = z.object({
  login: z.string().min(1, 'Username or email is required'),
  password: z.string().min(1, 'Password is required'),
});
type FormValues = z.infer<typeof schema>;

export default function LoginPage() {
  const { user, login } = useAuth();
  const router = useRouter();
  const [error, setError] = React.useState('');
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  React.useEffect(() => {
    if (user) router.replace('/dashboard');
  }, [user, router]);

  const onSubmit = async (values: FormValues) => {
    setError('');
    try {
      await login(values.login, values.password);
      router.replace('/dashboard');
    } catch (e) {
      setError(getApiError(e).message);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-900 to-primary/80 p-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-2xl">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-sky-400 text-white">
            <Gem className="size-6" />
          </div>
          <h1 className="text-xl font-bold">Jewellery ERP</h1>
          <p className="text-sm text-muted-foreground">Sign in to continue</p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Field label="Username or Email" required error={errors.login?.message}>
            <Input autoComplete="username" {...register('login')} />
          </Field>
          <Field label="Password" required error={errors.password?.message}>
            <Input type="password" autoComplete="current-password" {...register('password')} />
          </Field>

          {error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting && <Spinner />} Sign In
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Default: <code className="font-semibold">admin</code> / <code className="font-semibold">admin123</code>
        </p>
      </div>
    </div>
  );
}
