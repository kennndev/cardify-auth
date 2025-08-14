"use client"

import { Button } from "@/components/ui/button"
import { Sparkles, ShoppingCart } from "lucide-react"
import Link from "next/link"
import { useState, useEffect, useCallback } from "react"
import { useNavigationVisibility } from "@/hooks/use-navigation-visibility"
import { AnimatedHamburger } from "@/components/ui/animated-hamburger"
import { useCart } from "@/lib/cart-context"
import { CartDrawer } from "@/components/cart-drawer"
import { getSupabaseBrowserClient, signInWithGoogle, signOutUser } from "@/lib/supabase-browser"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { canCreateMore, getRemaining, FREE_LIMIT } from "@/lib/guest-quota"
import { AvatarBubble } from "@/components/Avatar"

export function Navigation() {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isCartOpen, setIsCartOpen] = useState(false)
  const [user, setUser] = useState<any>(null)
  const [remaining, setRemaining] = useState<number>(0)
  const isVisible = useNavigationVisibility()
  const { getItemCount } = useCart()
  const itemCount = getItemCount()

  const refreshRemaining = useCallback(() => {
    setRemaining(getRemaining())
  }, [])

  useEffect(() => {
    refreshRemaining()
    const onUpdate = () => refreshRemaining()
    window.addEventListener("cardify-free-updated", onUpdate)
    window.addEventListener("storage", onUpdate)
    return () => {
      window.removeEventListener("cardify-free-updated", onUpdate)
      window.removeEventListener("storage", onUpdate)
    }
  }, [refreshRemaining])

  useEffect(() => {
    const supabase = getSupabaseBrowserClient()
    supabase.auth.getUser().then(({ data }) => setUser(data.user ?? null))
    supabase.auth.getSession().then(({ data }) => setUser(data.session?.user ?? null))
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const handleGuestCreateClick = (path = "/upload") => {
    if (canCreateMore()) {
      window.location.href = path
    } else {
      signInWithGoogle(path)
    }
  }

  return (
    <>
      <nav
        className={`fixed top-0 left-0 right-0 z-50 px-6 py-4 bg-cyber-black/90 backdrop-blur-md border-b border-cyber-cyan/30 font-mono transition-transform duration-300 ease-in-out ${
          isVisible ? "translate-y-0" : "-translate-y-full"
        }`}
      >
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 group">
            <img src="/cardify-currentcolor_svg.svg" alt="Cardify" className="h-6 w-auto" />
          </Link>

          <div className="hidden md:flex items-center gap-4">
            {/* Create Card */}
            <Button
              onClick={() => handleGuestCreateClick("/upload")}
              className="bg-cyber-dark border-2 border-cyber-green text-cyber-green hover:bg-cyber-green/10"
              title={remaining > 0 ? `You have ${remaining} of ${FREE_LIMIT} free` : "Sign in required"}
            >
              <Sparkles className="w-4 h-4 mr-2" />
              {remaining > 0 ? `Create Card (${remaining} free)` : "Create Card"}
            </Button>

            {/* (Optional) Marketplace – keep/remove per your preference */}
            <Link href="/marketplace">
              <Button className="bg-cyber-dark border-2 border-cyber-green text-cyber-green hover:bg-cyber-green/10">
                <Sparkles className="w-4 h-4 mr-2" />
                Marketplace
              </Button>
            </Link>

            {/* Avatar area */}
            {user ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <span>
                    <AvatarBubble
                      src={user.user_metadata?.avatar_url}
                      name={user.user_metadata?.full_name || user.email}
                      title="Account"
                    />
                  </span>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="bg-cyber-black border border-cyber-cyan/30 text-white"
                >
                  <DropdownMenuItem asChild>
                    <Link href="/profile" className="text-cyber-green">
                      Profile
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={signOutUser}
                    className="text-cyber-pink cursor-pointer"
                  >
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <AvatarBubble
                src={"/default-avatar.png"}
                name={null}
                onClick={() => signInWithGoogle("/profile")}
                title="Sign in"
              />
            )}

            {/* Cart */}
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

          {/* Mobile controls */}
          <div className="flex items-center gap-2 md:hidden">
            <Button
              onClick={() => setIsCartOpen(!isCartOpen)}
              className="relative bg-cyber-dark border-2 border-cyber-cyan text-cyber-cyan p-2"
            >
              <ShoppingCart className="w-4 h-4" />
            </Button>
            <AnimatedHamburger
              isOpen={isMenuOpen}
              onClick={() => setIsMenuOpen(!isMenuOpen)}
            />
          </div>
        </div>

        {/* Mobile menu */}
        {isMenuOpen && (
          <div className="absolute top-full left-0 right-0 bg-cyber-black/95 backdrop-blur-md border-b border-cyber-cyan/30 md:hidden">
            <div className="px-6 py-4 space-y-4">
              {/* Create Card */}
              <Button
                onClick={() => {
                  setIsMenuOpen(false)
                  handleGuestCreateClick("/upload")
                }}
                className="w-full bg-cyber-dark border-2 border-cyber-green text-cyber-green hover:bg-cyber-green/10"
                title={remaining > 0 ? `You have ${remaining} of ${FREE_LIMIT} free` : "Sign in required"}
              >
                <Sparkles className="w-4 h-4 mr-2" />
                {remaining > 0 ? `Create Card (${remaining} free)` : "Create Card"}
              </Button>

              {/* (Optional) Marketplace – keep/remove per your preference */}
              <Link href="/marketplace" className="block">
                <Button
                  onClick={() => setIsMenuOpen(false)}
                  className="w-full bg-cyber-dark border-2 border-cyber-green text-cyber-green hover:bg-cyber-green/10"
                >
                  <Sparkles className="w-4 h-4 mr-2" />
                  Marketplace
                </Button>
              </Link>

              {/* Avatar dropdown (mobile) */}
              {user ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <div className="flex items-center gap-3">
                      <AvatarBubble
                        src={user.user_metadata?.avatar_url}
                        name={user.user_metadata?.full_name || user.email}
                        title="Account"
                      />
                      <span className="text-cyber-green font-medium">
                        {user.user_metadata?.full_name || "Profile"}
                      </span>
                    </div>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="bg-cyber-black border border-cyber-cyan/30 text-white"
                  >
                    <DropdownMenuItem asChild>
                      <Link
                        href="/profile"
                        onClick={() => setIsMenuOpen(false)}
                        className="text-cyber-green"
                      >
                        Profile
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setIsMenuOpen(false)
                        signOutUser()
                      }}
                      className="text-cyber-pink cursor-pointer"
                    >
                      Sign out
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-cyber-cyan">Sign in</span>
                  <AvatarBubble
                    src="/default-avatar.png"
                    onClick={() => signInWithGoogle("/profile")}
                    title="Sign in"
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </nav>

      <CartDrawer isOpen={isCartOpen} onClose={() => setIsCartOpen(false)} />
    </>
  )
}
