// components/Navigation.tsx
"use client"

import { Button } from "@/components/ui/button"
import { Sparkles, ShoppingCart } from "lucide-react"
import Link from "next/link"
import { useState, useEffect } from "react"
import { useNavigationVisibility } from "@/hooks/use-navigation-visibility"
import { AnimatedHamburger } from "@/components/ui/animated-hamburger"
import { useCart } from "@/lib/cart-context"
import { CartDrawer } from "@/components/cart-drawer"
import { getSupabaseBrowserClient, signInWithGoogle, signOutUser } from "@/lib/supabase-browser"

export function Navigation() {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isCartOpen, setIsCartOpen] = useState(false)
  const [user, setUser] = useState<any>(null)
  const isVisible = useNavigationVisibility()
  const { getItemCount } = useCart()
  const itemCount = getItemCount()

  useEffect(() => {
    const supabase = getSupabaseBrowserClient()

    // initial load
    supabase.auth.getUser().then(({ data }) => {
      console.log("[Nav] getUser:", data.user)
      setUser(data.user ?? null)
    })

    // subscribe to changes
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      console.log("[Nav] onAuthStateChange:", event, session?.user)
      setUser(session?.user ?? null)
    })
    return () => { sub.subscription.unsubscribe() }
  }, [])

  return (
    <>
      <nav className={`fixed top-0 left-0 right-0 z-50 px-6 py-4 bg-cyber-black/90 backdrop-blur-md border-b border-cyber-cyan/30 font-mono transition-transform duration-300 ease-in-out ${isVisible ? "translate-y-0" : "-translate-y-full"}`}>
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 group">
            <img src="/cardify-currentcolor_svg.svg" alt="Cardify" className="h-6 w-auto" />
          </Link>

          <div className="hidden md:flex items-center gap-4">
            {user ? (
              <>
                <Link href="/upload">
                  <Button className="bg-cyber-dark border-2 border-cyber-green text-cyber-green hover:bg-cyber-green/10">
                    <Sparkles className="w-4 h-4 mr-2" />
                    Create Card
                  </Button>
                </Link>
                <Link href="/profile">
                  <Button className="bg-cyber-dark border-2 border-cyber-green text-cyber-green hover:bg-cyber-green/10">
                    <Sparkles className="w-4 h-4 mr-2" />
                    My Profile
                  </Button>
                </Link>
                <Button onClick={signOutUser} className="bg-cyber-dark border-2 border-cyber-pink text-cyber-pink hover:bg-cyber-pink/10">
                  Sign out
                </Button>
              </>
            ) : (
              <Button onClick={() => signInWithGoogle("/profile")} className="bg-cyber-dark border-2 border-cyber-cyan text-cyber-cyan hover:bg-cyber-cyan/10">
                Sign in with Google
              </Button>
            )}

            <Button
              onClick={() => setIsCartOpen(!isCartOpen)}
              className="relative bg-cyber-dark border-2 border-cyber-cyan text-cyber-cyan hover:bg-cyber-cyan/10"
            >
              <ShoppingCart className="w-4 h-4" />
              {itemCount > 0 && (
                <span className="absolute -top-2 -right-2 bg-cyber-pink text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
                  {itemCount}
                </span>
              )}
            </Button>
          </div>

          <div className="flex items-center gap-2 md:hidden">
            <Button onClick={() => setIsCartOpen(!isCartOpen)} className="relative bg-cyber-dark border-2 border-cyber-cyan text-cyber-cyan p-2">
              <ShoppingCart className="w-4 h-4" />
            </Button>
            <AnimatedHamburger isOpen={isMenuOpen} onClick={() => setIsMenuOpen(!isMenuOpen)} />
          </div>
        </div>

        {isMenuOpen && (
          <div className="absolute top-full left-0 right-0 bg-cyber-black/95 backdrop-blur-md border-b border-cyber-cyan/30 md:hidden">
            <div className="px-6 py-4 space-y-4">
              {user ? (
                <>
                  <Link href="/upload" className="block">
                    <Button onClick={() => setIsMenuOpen(false)} className="w-full bg-cyber-dark border-2 border-cyber-green text-cyber-green hover:bg-cyber-green/10">
                      <Sparkles className="w-4 h-4 mr-2" />
                      Create Card
                    </Button>
                  </Link>
                  <Link href="/profile" className="block">
                    <Button onClick={() => setIsMenuOpen(false)} className="w-full bg-cyber-dark border-2 border-cyber-green text-cyber-green hover:bg-cyber-green/10">
                      <Sparkles className="w-4 h-4 mr-2" />
                      My Profile
                    </Button>
                  </Link>
                  <Button onClick={signOutUser} className="w-full bg-cyber-dark border-2 border-cyber-pink text-cyber-pink hover:bg-cyber-pink/10">
                    Sign out
                  </Button>
                </>
              ) : (
                <Button onClick={() => signInWithGoogle("/profile")} className="w-full bg-cyber-dark border-2 border-cyber-cyan text-cyber-cyan hover:bg-cyber-cyan/10">
                  Sign in with Google
                </Button>
              )}
            </div>
          </div>
        )}
      </nav>

      <CartDrawer isOpen={isCartOpen} onClose={() => setIsCartOpen(false)} />
    </>
  )
}
