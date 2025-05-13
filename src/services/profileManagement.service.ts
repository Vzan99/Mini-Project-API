import { randomBytes } from "crypto";
import { hash, compare, genSaltSync } from "bcrypt";
import prisma from "../lib/prisma";
import { transporter } from "../utils/nodemailer";
import {
  iChangePasswordParam,
  iForgotPasswordParam,
  iResetPasswordParam,
  iUpdateProfileParam,
  iUploadProfilePictureParam,
  iVerifyResetTokenParam,
} from "../interfaces/profileManagement.Interface";
import { cloudinaryUpload, cloudinaryRemove } from "../utils/cloudinary";
import { NODEMAILER_USER } from "../config";

import Handlebars from "handlebars";
import path from "path";
import fs from "fs";

function generateResetToken(): string {
  return randomBytes(32).toString("hex");
}

async function findUserByEmail(email: string) {
  try {
    const user = await prisma.user.findFirst({
      select: {
        id: true,
        email: true,
        first_name: true,
        last_name: true,
        password: true,
        role: true,
        reset_token: true,
        reset_expires_at: true,
      },
      where: { email },
    });
    return user;
  } catch (err) {
    throw err;
  }
}

// request reset password
async function forgotPasswordService(param: iForgotPasswordParam) {
  try {
    const email = param.email;
    const user = await findUserByEmail(email);

    //get email from param
    if (!user) throw new Error("User not found");

    const resetToken = generateResetToken();
    const resetExpiresAt = new Date();
    // Set the token to expire in 24 hours
    resetExpiresAt.setHours(resetExpiresAt.getHours() + 24);

    //update reset token and reset expires at to the user
    await prisma.user.update({
      where: { email },
      data: {
        reset_token: resetToken,
        reset_expires_at: resetExpiresAt,
      },
    });

    // Replace template with hardcoded HTML
    const htmlContent = `
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Forgot Your Password?</title>
      </head>
      <body>
        <div style="font-family: sans-serif; color: #333;">
          <h2 style="color: #4F46E5;">Reset Your Password</h2>
          <p>You requested a password reset for your Ticket account.</p>
          <p>Click the button below to set a new password. This link is valid for 24
            hours.</p>
          <div style="margin: 24px 0;">
            <a
              href="https://yourdomain.com/reset-password?email=${email}&token=${resetToken}"
              style="background-color: #4F46E5; color: white; padding: 12px 20px; text-decoration: none; border-radius: 6px;"
            >
              Reset Password
            </a>
          </div>
          <p>If you didn't request this, please ignore this email.</p>
        </div>
      </body>
    </html>`;

    await transporter.sendMail({
      from: `"Ticket Admin" ${NODEMAILER_USER}`,
      to: email,
      subject: "Password Reset Request",
      html: htmlContent,
    });

    return { message: "Password reset email sent" };
  } catch (err) {
    throw err;
  }
}

// verify reset token
async function verifyResetTokenService(param: iVerifyResetTokenParam) {
  try {
    const { email, reset_token } = param;

    const user = await prisma.user.findUnique({
      where: { email },
    });

    //check if the user exists
    if (!user) {
      throw new Error("User not found");
    }

    //check if the token is valid
    if (user.reset_token !== reset_token) {
      throw new Error("Invalid reset token");
    }

    // Check if the token has expired or not
    if (!user.reset_expires_at || user.reset_expires_at < new Date()) {
      throw new Error("Reset token has expired");
    }

    return { valid: true };
  } catch (err) {
    throw err;
  }
}

// Reset password with token
async function resetPasswordService(param: iResetPasswordParam) {
  try {
    const { email, reset_token, newPassword } = param;

    return await prisma.$transaction(async (tx) => {
      // Find user within transaction - use findFirst instead of findUnique
      const user = await tx.user.findFirst({
        where: { email },
        select: {
          id: true,
          reset_token: true,
          reset_expires_at: true,
        },
      });

      if (!user) {
        throw new Error("User not found");
      }

      // Debug logs
      console.log("User token from DB:", user.reset_token);
      console.log("Token from request:", reset_token);

      // Verify token
      if (user.reset_token !== reset_token) {
        throw new Error("Invalid reset token");
      }

      if (!user.reset_expires_at || user.reset_expires_at < new Date()) {
        throw new Error("Reset token has expired");
      }

      // Hash the new password
      const salt = genSaltSync(10);
      const hashedPassword = await hash(newPassword, salt);

      // Update password and clear token
      await tx.user.update({
        where: { email },
        data: {
          password: hashedPassword,
          reset_token: null,
          reset_expires_at: null,
        },
      });

      return { message: "Password has been reset successfully" };
    });
  } catch (err) {
    throw err;
  }
}

async function changePasswordService(param: iChangePasswordParam) {
  try {
    const { id, current_password, new_password } = param;

    const user = await prisma.user.findUnique({
      where: { id },
      select: { password: true },
    });

    if (!user) {
      throw new Error("User not found");
    }

    const checkPassword = await compare(current_password, user.password);

    if (!checkPassword) {
      throw new Error("Current password is incorrect");
    }

    const salt = genSaltSync(10);
    const hashedPassword = await hash(new_password, salt);

    await prisma.user.update({
      where: { id },
      data: {
        password: hashedPassword,
      },
    });

    return { message: "Password has been changed successfully" };
  } catch (err) {
    throw err;
  }
}

async function updateProfileService(param: iUpdateProfileParam) {
  try {
    const { id, ...updateData } = param;

    // check if username that is being update is unique

    if (updateData.username) {
      const existingUsername = await prisma.user.findFirst({
        where: {
          username: updateData.username,
          NOT: {
            id: id, // Exclude the current user
          },
        },
      });

      // if username is not unique, throw an error
      if (existingUsername) {
        throw new Error("Username already taken");
      }
    }

    // update the user profile
    const updatedUser = await prisma.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        first_name: true,
        last_name: true,
        username: true,
        email: true,
        profile_picture: true,
        role: true,
        created_at: true,
        updated_at: true,
      },
    });

    console.log(updatedUser);

    return { message: "profile updated successfully", updatedUser };
  } catch (err) {
    throw err;
  }
}

async function uploadProfilePictureService(param: iUploadProfilePictureParam) {
  let imageUrl: string | null = null;
  let filename = "";
  try {
    // 1) Upload to Cloudinary if a file was provided
    if (param.file) {
      const { secure_url } = await cloudinaryUpload(param.file);
      imageUrl = secure_url;
      const splitUrl = secure_url.split("/");
      filename = splitUrl[splitUrl.length - 1];
    } else {
      throw new Error("No file was provided");
    }

    // 2) Use transaction for database operations
    const result = await prisma.$transaction(async (t) => {
      // Get current user to check if we need to delete old profile picture
      const currentUser = await t.user.findUnique({
        where: { id: param.id },
        select: { profile_picture: true },
      });

      // Update the user's profile picture
      const updatedUser = await t.user.update({
        where: { id: param.id },
        data: {
          profile_picture: filename,
        },
        select: {
          id: true,
          first_name: true,
          last_name: true,
          username: true,
          email: true,
          profile_picture: true,
          role: true,
          created_at: true,
          updated_at: true,
        },
      });

      return {
        updatedUser,
        oldPicture: currentUser?.profile_picture,
      };
    });

    // 3) Remove old profile picture if it exists
    if (result.oldPicture) {
      try {
        await cloudinaryRemove(result.oldPicture);
      } catch (cleanupErr) {
        console.error("Failed to remove old profile picture:", cleanupErr);
        // Non-critical error, don't throw
      }
    }

    return {
      message: "Profile picture updated successfully",
      updatedUser: result.updatedUser,
    };
  } catch (err) {
    // 4) Cleanup Cloudinary if upload succeeded but something else failed
    if (imageUrl) {
      await cloudinaryRemove(imageUrl);
    }
    throw err;
  }
}

export {
  forgotPasswordService,
  verifyResetTokenService,
  resetPasswordService,
  changePasswordService,
  updateProfileService,
  uploadProfilePictureService,
};
